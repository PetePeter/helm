package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactRepository
import com.potatomotato.helm.data.ArtifactIntent
import com.potatomotato.helm.data.ArtifactUploads
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.attachmentSliceBytes
import com.potatomotato.helm.data.AttachmentPulls
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.PullTarget
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.ControlRepository
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.ShareFlow
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.RANK_LAN
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.save.SavedFile
import com.potatomotato.helm.data.ArtifactRules
import kotlin.coroutines.resume
import java.io.InputStream
import com.potatomotato.helm.wire.MobileRecord


class ArtifactClient internal constructor(
    internal val core: HelmClient,
    val state: ArtifactRepository,
    val uploads: ArtifactUploads,
    val shares: ShareFlow,
    internal val control: ControlRepository,
    private val chats: ChatRepository,
) {
    private val transfer = ArtifactTransfer(this)

    /**
     * The wire protocol the live link negotiated — 0 with no link. Uploads are a
     * protocol-4 feature, so the editor's attach toolbar greys from THIS rather
     * than from this build's own maximum: a protocol-3 desktop links fine and
     * simply has no upload half to offer.
     */
    var negotiatedProtocol: () -> Int = { 0 }

    /**
     * A staged file's bytes, opened fresh for one upload attempt. Settable like
     * [saveAttachment] — the staged copy lives in a Context-owned cache dir and
     * this client is built before there is a Context. Null means the copy is
     * gone (the system swept the cache mid-upload), which fails the chip rather
     * than the link.
     */
    var openStagedAttachment: (StagedAttachment) -> java.io.InputStream? = { null }

    /**
     * Copy a pick into the app's own cache and measure it — size and whole-file
     * sha256 — returning the staged file, or null when the pick could not be
     * read. Suspends because the copy is disk I/O a tap must not do on the main
     * thread. Settable for the same Context reason as [openStagedAttachment].
     */
    var stageAttachment: suspend (source: String, displayName: String, mimeType: String?) -> StagedAttachment? =
        { _, _, _ -> null }

    /**
     * The artifacts of one session, for the artifacts screen. Like the terminal
     * tail, this is PULLED when the screen asks for it, never streamed: the list
     * is a bounded answer and the link's budget belongs to the user's taps.
     */
    fun refreshArtifacts(sessionId: String): Boolean {
        state.listRequested(sessionId)
        return core.call(HelmClient.METHOD_SESSION_ARTIFACT_LIST, linkedMapOf("sessionId" to sessionId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    // A shape the app cannot read is a failure the screen shows,
                    // never a calm empty list that quietly means "no answer".
                    if (!state.listArrived(sessionId, outcome.result)) {
                        state.listFailed(sessionId, HelmClient.UNREADABLE_ARTIFACTS)
                    }
                is HelmClient.Outcome.Failed -> state.listFailed(sessionId, outcome.message)
            }
        }
    }

    /**
     * One artifact's body — the version asked for, or the latest when [version]
     * is null. The desktop sends exactly ONE version's content per answer, so
     * version paging on the detail screen is a re-ask, not a local cache walk.
     * The session id rides along to the repository because the read cache is
     * per-session: the same artifact id in two sessions is two bodies, and a
     * cached answer from the wrong session would be a convincing lie.
     */
    fun readArtifact(sessionId: String, artifactId: String, version: Int?): Boolean {
        state.readRequested(sessionId, artifactId, version)
        val params = linkedMapOf<String, Any>("sessionId" to sessionId, "artifactId" to artifactId)
        if (version != null) params["version"] = version
        return core.call(HelmClient.METHOD_SESSION_ARTIFACT_GET, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!state.readArrived(sessionId, artifactId, version, outcome.result)) {
                        state.readFailed(artifactId, HelmClient.UNREADABLE_ARTIFACT)
                    }
                is HelmClient.Outcome.Failed -> state.readFailed(artifactId, outcome.message)
            }
        }
    }

    /**
     * Mint a NEW markdown artifact for the session. `kind` rides as `md` on the
     * wire — the desktop's session-addressed create refuses anything else
     * (markdown-only in v1) — so the phone never authors a kind of its own.
     *
     * The body is budgeted HERE, before any bytes reach the radio, against the
     * same 128KiB frame the desktop caps its answers with: a request the link
     * cannot carry dies as a torn link, not as a refusal.
     */
    fun createArtifact(
        sessionId: String,
        title: String,
        content: String,
        attachmentKeys: List<String> = emptyList(),
        intent: ArtifactIntent? = ArtifactIntent.Normal,
    ): Boolean {
        if (!ArtifactRules.fitsCreate(title, content)) {
            control.noticed(SessionAction.CreateArtifact, ActionOutcome.Failed(HelmClient.TOO_LARGE))
            return false
        }
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            "title" to ArtifactRules.title(title),
            "kind" to HelmClient.CREATE_KIND,
            "content" to content,
        )
        intent?.let { params["intent"] = it.wireValue }
        return core.act(control, 
            SessionAction.CreateArtifact,
            HelmClient.METHOD_SESSION_ARTIFACT_CREATE,
            params,
        ) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) {
                val artifactId = core.idIn(outcome.result)
                if (attachmentKeys.isEmpty() || artifactId == null) {
                    control.artifactLanded(SessionAction.CreateArtifact, artifactId)
                } else {
                    // THE one deferral in this client: the notice that moves the
                    // user waits until the staged files have crossed too. An
                    // editor that closed on create would strand a half-sent
                    // attachment with nowhere to show its failure.
                    beginArtifactUploads(SessionAction.CreateArtifact, sessionId, artifactId)
                }
            }
        }
    }

    /**
     * Revise an artifact the session owns. Only the CHANGED fields ride
     * `session_artifact_update`: a new body appends a version, a new title
     * renames (the desktop adds no version for a title-only call). No
     * follow-up ask is made: returning to the detail screen re-pulls the body
     * the way every visit does, and that re-pull is the reconciliation.
     *
     * Staged files ride a revise exactly as they ride a create, against the id
     * being edited. A revise that ONLY adds files skips the update call and
     * starts the upload chain straight away.
     */
    fun reviseArtifact(
        sessionId: String,
        artifactId: String,
        revision: ArtifactRules.Revision,
        attachmentKeys: List<String> = emptyList(),
        intent: ArtifactIntent? = null,
    ): Boolean {
        if (revision.changesText && !ArtifactRules.fitsRevise(revision)) {
            control.noticed(SessionAction.ReviseArtifact, ActionOutcome.Failed(HelmClient.TOO_LARGE))
            return false
        }
        if (!revision.changesText && revision.newTitle == null && intent != null) {
            val params = linkedMapOf<String, Any>(
                "sessionId" to sessionId,
                "artifactId" to artifactId,
                "intent" to intent.wireValue,
            )
            return core.act(control, SessionAction.SetArtifactIntent, HelmClient.METHOD_SESSION_ARTIFACT_SET_INTENT, params) { outcome ->
                if (outcome is HelmClient.Outcome.Ok) {
                    if (attachmentKeys.isEmpty()) control.artifactLanded(SessionAction.ReviseArtifact, artifactId)
                    else beginArtifactUploads(SessionAction.ReviseArtifact, sessionId, artifactId)
                }
            }
        }
        if (!revision.changesText && intent == null) {
            if (attachmentKeys.isEmpty()) return false
            beginArtifactUploads(SessionAction.ReviseArtifact, sessionId, artifactId)
            return true
        }
        val params = linkedMapOf<String, Any>("sessionId" to sessionId, "artifactId" to artifactId)
        revision.newBody?.let { params["content"] = it }
        revision.newTitle?.let { params["title"] = it }
        intent?.let { params["intent"] = it.wireValue }
        return core.act(control, SessionAction.ReviseArtifact, HelmClient.METHOD_SESSION_ARTIFACT_UPDATE, params) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) {
                if (attachmentKeys.isEmpty()) {
                    control.artifactLanded(SessionAction.ReviseArtifact, artifactId)
                } else {
                    // Same deferral a create makes: the notice that closes the
                    // editor waits for the last commit, so a failed upload still
                    // has a chip to explain itself on.
                    beginArtifactUploads(SessionAction.ReviseArtifact, sessionId, artifactId)
                }
            }
        }
    }

    /**
     * Delete exactly ONE artifact. There is no bulk delete on the wire and this
     * app offers none; the artifacts screen confirms before this call exists.
     */
    fun deleteArtifact(sessionId: String, artifactId: String): Boolean =
        core.act(control, 
            SessionAction.DeleteArtifact,
            HelmClient.METHOD_SESSION_ARTIFACT_DELETE,
            linkedMapOf("sessionId" to sessionId, "artifactId" to artifactId),
        ) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) control.artifactLanded(SessionAction.DeleteArtifact, artifactId)
        }

    /**
     * Fetch one artifact as a FILE — `{filename, mimeType, base64, …}` — rather
     * than inline content. The outcome is deliberately NOT noticed on `Ok`: the
     * bytes have not been saved yet, and the notice that says "saved" waits for
     * the device sink. A refusal or a dead link IS noticed like any other
     * action, because those are verdicts the user must be able to read.
     */
    fun downloadArtifact(sessionId: String, artifactId: String, version: Int? = null): Boolean {
        state.downloadRequested(artifactId)
        val params = linkedMapOf<String, Any>("sessionId" to sessionId, "artifactId" to artifactId)
        if (version != null) params["version"] = version
        return fetchArtifactFile(artifactId, params)
    }

    /**
     * Fetch one artifact's ATTACHMENT — a binary file the desktop stores beside
     * the artifact and the list names as metadata — by the same
     * `session_artifact_download` tool, with `attachmentId` instead of `version`
     * (the desktop refuses the two together).
     *
     * SLICED, exactly like a chat attachment, and for a reason that was once a
     * bug: the desktop always slices an attachment and DEFAULTS the length to one
     * slice budget, so a single ask with no offset answers the first slice and
     * nothing more. This screen used to save that answer as if it were the whole
     * file, which is how a multi-megabyte image arrived truncated and opened
     * corrupt. An artifact BODY download stays single-shot — it has its own
     * inline cap and is answered whole.
     */
    fun downloadArtifactAttachment(
        sessionId: String,
        artifactId: String,
        attachment: HelmArtifactAttachment,
        previewOnly: Boolean = false,
    ): Boolean = pullAttachment(
        sessionId,
        state.attachmentPulls,
        PullTarget(
            key = artifactAttachmentKey(artifactId, attachment.id),
            artifactId = artifactId,
            attachmentId = attachment.id,
            filename = attachment.filename,
            // The desktop's content type is a hint it may never have had; a file
            // with no type still saves, as the generic one.
            mimeType = attachment.contentType?.takeIf { it.isNotBlank() } ?: HelmClient.DEFAULT_MIME,
            sizeBytes = attachment.sizeBytes,
            sha256 = attachment.sha256,
            generatedMedia = attachment.generatedMedia,
            previewOnly = previewOnly,
        ),
    )

    /** Load an artifact image for the gallery without adding it to Downloads. */
    fun previewArtifactAttachment(
        sessionId: String,
        artifactId: String,
        attachment: HelmArtifactAttachment,
    ): Boolean = downloadArtifactAttachment(sessionId, artifactId, attachment, previewOnly = true)

    /**
     * Where a pulled chat attachment is written, and what to call the place it
     * landed. A settable port for the same reason [onLanAddresses] is one: the
     * device sink needs a Context and this client is built before there is one.
     * The default refuses, so a build that never wires it fails legibly on the
     * tile rather than pretending to have saved something.
     */
    var saveAttachment: (filename: String, mimeType: String, content: InputStream) -> SavedFile = { _, _, _ ->
        throw IllegalStateException(HelmClient.NO_FILE_SINK)
    }

    /** Temporary image previews use app cache; explicit downloads use [saveAttachment]. */
    var savePreviewAttachment: (filename: String, mimeType: String, content: InputStream) -> SavedFile = { _, _, _ ->
        throw IllegalStateException(HelmClient.NO_FILE_SINK)
    }

    /**
     * Fetch a chat attachment, slice by slice, and save it when the last one
     * lands.
     *
     * The loop lives here rather than in the screen because a transfer outruns
     * its composable: scrolling the tile away or leaving the thread must not
     * restart a fetch that is halfway across a BLE link. Each slice's answer
     * asks for the next one — no timer, no concurrency, and therefore no way
     * for two slices to be in flight writing into one buffer.
     *
     * Returns false when there is nothing to start: no link, or a fetch for
     * this message is already running.
     */
    fun pullChatAttachment(sessionId: String, key: String, attachment: ChatAttachment): Boolean =
        pullAttachment(
            sessionId,
            chats.attachmentPulls,
            PullTarget(
                key = key,
                artifactId = attachment.artifactId,
                attachmentId = attachment.attachmentId,
                filename = attachment.filename,
                mimeType = attachment.mimeType,
                sizeBytes = attachment.sizeBytes,
                sha256 = attachment.sha256,
                generatedMedia = attachment.generatedMedia,
            ),
        )

    /**
     * Fetch ANY attachment, slice by slice, and save it when the last one lands.
     *
     * [pulls] is which set of rows is watching — a chat thread's or an artifact
     * screen's. Nothing below this line knows the difference, which is the point:
     * the slicing rules are hard-won (out-of-order answers, duplicate answers,
     * resume-at-the-gap) and a second copy of them would be a second chance to
     * get them wrong.
     */
    fun pullAttachment(sessionId: String, pulls: AttachmentPulls, target: PullTarget): Boolean {
        if (!pulls.pullStarted(target.key, target.sizeBytes, target.sha256)) return false
        return fillPipeline(sessionId, pulls, target)
    }

    /**
     * Keep the window full. Called to start, and again as each answer lands.
     *
     * The driver decides what may be asked for; this only issues it. That keeps
     * the one rule that matters — how much is in flight — in the place that can
     * be tested without a link.
     */
    private fun fillPipeline(sessionId: String, pulls: AttachmentPulls, target: PullTarget): Boolean {
        var issued = false
        while (true) {
            // Sized against the transport that owns the link right now: LAN
            // preempts BLE mid-transfer, and a slice sized for the wrong one is
            // refused, not merely slow.
            val sliceBytes = attachmentSliceBytes(HelmLink.holderRank, RANK_LAN)
            val offset = pulls.nextAsk(target.key, sliceBytes) ?: return issued
            issued = true
            if (!requestSlice(sessionId, pulls, target, offset, sliceBytes)) return issued
        }
    }

    private fun requestSlice(
        sessionId: String,
        pulls: AttachmentPulls,
        target: PullTarget,
        offset: Long,
        sliceBytes: Int,
    ): Boolean = core.call(
        HelmClient.METHOD_SESSION_ARTIFACT_DOWNLOAD,
        linkedMapOf(
            "sessionId" to sessionId,
            "artifactId" to target.artifactId,
            "attachmentId" to target.attachmentId,
            "offset" to offset,
            "length" to sliceBytes,
        ),
    ) { outcome ->
        when (outcome) {
            is HelmClient.Outcome.Ok -> takeSlice(sessionId, pulls, target, offset, outcome.result)
            is HelmClient.Outcome.Failed -> pulls.pullFailed(target.key, outcome.message)
        }
    }

    /**
     * One slice's answer, which arrives as RAW BYTES in a [MobileRecord.Blob] —
     * no base64, no JSON around the body. An answer of any other shape is a
     * failure, not an empty slice: treating it as empty would leave the loop
     * asking for the same offset forever.
     */
    private fun takeSlice(
        sessionId: String,
        pulls: AttachmentPulls,
        target: PullTarget,
        offset: Long,
        result: Any?,
    ) {
        val blob = result as? MobileRecord.Blob
        if (blob == null) {
            HelmLog.w(HelmLog.CLIENT, "an attachment slice did not arrive as a binary record")
            pulls.pullFailed(target.key, HelmClient.UNREADABLE_DOWNLOAD)
            return
        }

        val whole = pulls.sliceArrived(target.key, offset, blob.bytes, blob.eof)
        if (whole == null) {
            // More to come. Top the window back up — a slot just freed.
            if (pulls.pullState(target.key) is PullState.Pulling) {
                fillPipeline(sessionId, pulls, target)
            }
            return
        }

        try {
            // The desktop's own filename for the slice wins where it has one: it
            // is the name the file was stored under, and the metadata row may be
            // older than a rename.
            val name = blob.filename.takeIf { it.isNotBlank() } ?: target.filename
            val saved = whole.inputStream().use { content ->
                if (target.previewOnly) {
                    savePreviewAttachment(name, target.mimeType, content)
                } else {
                    saveAttachment(name, target.mimeType, content)
                }
            }
            pulls.pullSaved(target.key, saved.location, saved.uri, previewOnly = target.previewOnly)
        } catch (error: Exception) {
            HelmLog.w(HelmLog.CLIENT, "a pulled attachment could not be written to storage")
            pulls.pullFailed(target.key, error.message ?: HelmClient.NO_FILE_SINK)
        }
    }

    /**
     * Bin ONE attachment without binning the artifact that holds it — the single
     * path for the editor's delete, a replace's second half, and a chat tile's
     * delete. On Ok the cached artifact row loses it at once (and a re-pull
     * reconciles); on failure the row stays and records why. [onDeleted] is for
     * callers with their own mirror to prune, like the chat tile.
     */
    fun deleteArtifactAttachment(
        sessionId: String,
        artifactId: String,
        attachmentId: String,
        onDeleted: () -> Unit = {},
    ): Boolean {
        state.attachmentEditStarted(attachmentId)
        return core.act(control, 
            SessionAction.DeleteArtifact,
            HelmClient.METHOD_SESSION_ARTIFACT_ATTACHMENT_DELETE,
            linkedMapOf(
                "sessionId" to sessionId,
                "artifactId" to artifactId,
                "attachmentId" to attachmentId,
            ),
        ) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    state.attachmentRemoved(sessionId, artifactId, attachmentId)
                    onDeleted()
                }
                is HelmClient.Outcome.Failed -> state.attachmentEditFailed(attachmentId, outcome.message)
            }
        }
    }

    /** A chat tile's delete: the artifact attachment, then the tile that showed it. */
    fun deleteChatAttachment(sessionId: String, key: String, attachment: ChatAttachment): Boolean =
        deleteArtifactAttachment(sessionId, attachment.artifactId, attachment.attachmentId) {
            chats.remove(sessionId, key)
        }

    /**
     * A replacement's commit answered Ok: only NOW is the old file deleted. The
     * chip retires once the delete lands, and the list re-pull shows the swap.
     */
    internal fun retireReplaced(sessionId: String, artifactId: String, key: String) {
        val old = uploads.replaces(key) ?: return
        deleteArtifactAttachment(sessionId, artifactId, old) {
            uploads.unstage(key)
            refreshArtifacts(sessionId)
        }
    }

    /** One `session_artifact_download` ask; [artifactId] is who the answer belongs to. */
    private fun fetchArtifactFile(artifactId: String, params: Map<String, Any>): Boolean =
        core.call(HelmClient.METHOD_SESSION_ARTIFACT_DOWNLOAD, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!state.downloadArrived(artifactId, outcome.result)) {
                        state.downloadFailed(artifactId, HelmClient.UNREADABLE_DOWNLOAD)
                    }
                is HelmClient.Outcome.Failed -> {
                    control.noticed(SessionAction.SaveArtifact, core.outcomeFor(outcome))
                    state.downloadFailed(artifactId, outcome.message)
                }
            }
        }

    /** Swap an artifact attachment, keeping the old copy until the new one commits. */
    fun replaceArtifactAttachment(
        sessionId: String,
        artifactId: String,
        oldAttachmentId: String,
        staged: StagedAttachment,
    ): Boolean = transfer.replaceArtifactAttachment(sessionId, artifactId, oldAttachmentId, staged)

    /** Start the staged-file chain against an artifact that now exists. */
    fun beginArtifactUploads(action: SessionAction, sessionId: String, artifactId: String) =
        transfer.beginArtifactUploads(action, sessionId, artifactId)

    /** Retry failed staged files, first staged first. */
    fun retryArtifactUploads(): Boolean = transfer.retryArtifactUploads()

    /** Share a staged file into a session or return its landed path to the composer. */
    fun shareFile(
        sessionId: String,
        sessionName: String,
        staged: StagedAttachment,
        onLanded: ((path: String) -> Unit)? = null,
    ): Boolean = transfer.shareFile(sessionId, sessionName, staged, onLanded)

    /** Continue is UI-only: the same upload request keeps running. */
    fun continueShareWait(attemptId: Long) = transfer.continueShareWait(attemptId)

    /** Stop the local pump and ask Helm to drop the slot. */
    fun cancelShare(attemptId: Long) = transfer.cancelShare(attemptId)

}
