package com.potatomotato.helm.link

import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.wire.MobileEnvelope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume


internal class ArtifactTransfer(private val client: ArtifactClient) {
    private var shareSequence = 0L

    private val shareLock = Any()

    @Volatile private var activeShare: ActiveShare? = null

    private class ActiveShare(
        val attemptId: Long,
        val sessionName: String,
        val onLanded: ((String) -> Unit)?,
    ) {
        var offer: UploadOffer? = null
        var job: Job? = null
        var waitPrompt: Cancellable? = null
        var cancelRequested = false
        var cancelRequestPending = false
    }

    /** A desktop's answer to a slot-open: where to send the bytes and how big a slice may be. */
    private data class UploadOffer(
        val uploadId: String,
        val maxSliceBytes: Long,
        val total: Long,
    )

    /**
     * Which action the staged-file chain is finishing, so the notice that lands
     * when the last commit answers names what the user actually did.
     *
     * A field rather than an argument threaded through the chain because a retry
     * tap arrives long after the chain began and has to land under the same
     * heading; the repository already keeps the artifact and session for the same
     * reason.
     */
    private var uploadAction: SessionAction = SessionAction.CreateArtifact

    /**
     * Whether the chain's end should navigate (the create/revise landing). A
     * replace started from inside the editor must NOT: the user is mid-edit, and
     * being thrown to the detail screen would discard the body they are typing.
     */
    private var landOnFinish: Boolean = true

    /**
     * Swap an existing attachment for a newly picked file, in the one order that
     * cannot lose data: upload + commit the new file first, and delete the old
     * one only once that commit has answered Ok (see the commit handler). An
     * upload that fails leaves the original untouched and a retryable chip.
     *
     * If a chain is already running the replacement just joins its queue — two
     * chains at once would interleave slices on the link.
     */
    fun replaceArtifactAttachment(
        sessionId: String,
        artifactId: String,
        oldAttachmentId: String,
        staged: StagedAttachment,
    ): Boolean {
        if (!client.uploads.stageReplacement(staged, oldAttachmentId)) return false
        client.state.attachmentEditStarted(oldAttachmentId)
        if (client.uploads.anyUploading()) return true
        landOnFinish = false
        client.uploads.beginUploads(artifactId, sessionId)
        startArtifactUploads(sessionId, artifactId)
        return true
    }

    /**
     * Start the staged-file chain against an artifact that now EXISTS.
     *
     * The one entry point for both halves of the editor: a create reaches it once
     * the new id lands, a revise reaches it with the id it was already editing.
     * Revise had no attachment path at all before this — staged files were
     * silently dropped on submit, which looked exactly like an upload that failed
     * without saying so.
     */
    fun beginArtifactUploads(action: SessionAction, sessionId: String, artifactId: String) {
        uploadAction = action
        landOnFinish = true
        client.uploads.beginUploads(artifactId, sessionId)
        startArtifactUploads(sessionId, artifactId)
    }

    /**
     * Send the staged files of one create, one at a time, in staged order.
     *
     * Serial is a constraint, not a taste: the link's frame budget is small and
     * its round trips expensive, and interleaving two files would spend both on
     * progress nobody can read. Each file's chain is
     * open-a-slot → stream slices → commit, and the next file starts only when
     * this one's commit has ANSWERED — so a failure leaves exactly one chip to
     * explain itself.
     */
    private fun startArtifactUploads(sessionId: String, artifactId: String) {
        val next = client.uploads.pendingKeys().firstOrNull()
        if (next == null) {
            finishArtifactUploads(sessionId, artifactId)
        } else {
            sendArtifactAttachment(sessionId, artifactId, next)
        }
    }

    /**
     * Try the failed files again, first staged first. The editor's retry tap
     * lands here; the repository remains the authority on what is still owed —
     * this never re-sends a file the desktop has already committed.
     */
    fun retryArtifactUploads(): Boolean {
        val artifactId = client.uploads.targetArtifactId ?: return false
        val sessionId = client.uploads.targetSessionId ?: return false
        if (client.uploads.pendingKeys().isEmpty()) return false
        return sendArtifactAttachment(sessionId, artifactId, client.uploads.pendingKeys().first())
    }

    /**
     * One file's chain, first half: open a slot on the desktop. The offer that
     * comes back names the slot the raw slices address — the slices carry NO
     * session, artifact or filename authority beyond that id, which is why the
     * desktop can refuse a slice from any other device without guessing.
     */
    private fun sendArtifactAttachment(sessionId: String, artifactId: String, key: String): Boolean {
        val staged = client.uploads.stagedAttachment(key)
        if (staged == null) {
            client.uploads.uploadFailed(key, HelmClient.STAGE_GONE)
            return false
        }
        client.uploads.uploadStarted(key, staged.sizeBytes)
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            "artifactId" to artifactId,
            "filename" to staged.filename,
            "sizeBytes" to staged.sizeBytes,
            "sha256" to staged.sha256,
        )
        staged.mimeType?.takeIf { it.isNotBlank() }?.let { params["contentType"] = it }
        return client.core.call(HelmClient.METHOD_SESSION_ARTIFACT_ATTACHMENT_ADD, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    val offer = uploadOffer(outcome.result)
                    if (offer == null) {
                        client.uploads.uploadFailed(key, HelmClient.UNREADABLE_UPLOAD_OFFER)
                    } else {
                        streamArtifactUpload(sessionId, artifactId, key, staged, offer)
                    }
                }
                is HelmClient.Outcome.Failed -> client.uploads.uploadFailed(key, outcome.message)
            }
        }
    }

    /**
     * One file's chain, middle: the bytes, as raw blob records addressed to the
     * slot. Slice budget comes from the desktop's offer, clipped to a local
     * ceiling so a generous offer can never push a frame past what this link's
     * transports carry — the advertised number is the RECEIVER's tolerance, not
     * a promise about our own radio.
     *
     * The file is re-read from zero on every attempt, and every attempt opens a
     * NEW slot: a retry after a failed commit cannot know how much of the old
     * slot survived, and an append into a slot of unknown depth is how a file
     * arrives plausible and wrong.
     */
    private fun streamArtifactUpload(
        sessionId: String,
        artifactId: String,
        key: String,
        staged: StagedAttachment,
        offer: UploadOffer,
    ) {
        // LAUNCHED, not run here. This is called from the inbound path — the
        // collector that delivers every frame the desktop sends — and a file's
        // worth of slices took that path hostage for the whole transfer, so
        // nothing else the desktop said could be heard meanwhile. It also has to
        // be able to WAIT (see [awaitFlushed]), which the inbound path must not.
        client.core.uploadScope.launch { streamArtifactUploadSlices(sessionId, artifactId, key, staged, offer) }
    }

    private suspend fun streamArtifactUploadSlices(
        sessionId: String,
        artifactId: String,
        key: String,
        staged: StagedAttachment,
        offer: UploadOffer,
    ) {
        val failure = pumpSlices(staged, offer) { sent -> client.uploads.uploadProgress(key, sent) }
        if (failure != null) {
            client.uploads.uploadFailed(key, failure)
            return
        }
        // One file's chain, last half: the commit. The desktop verifies the size
        // and the sha256 declared at slot-open against what actually arrived —
        // the slices themselves are silent, so this is the only moment the
        // phone learns whether the file exists on the other end.
        val issued = client.core.call(
            HelmClient.METHOD_SESSION_ARTIFACT_ATTACHMENT_COMMIT,
            linkedMapOf("uploadId" to offer.uploadId),
        ) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    client.uploads.uploadDone(key, attachmentIdIn(outcome.result))
                    client.retireReplaced(sessionId, artifactId, key)
                    startArtifactUploads(sessionId, artifactId)
                }
                is HelmClient.Outcome.Failed -> client.uploads.uploadFailed(key, outcome.message)
            }
        }
        // A commit the link refused to carry fails the chip here rather than
        // leaving it Uploading against a slot the desktop will evict.
        if (!issued) client.uploads.uploadFailed(key, HelmClient.NOT_LINKED)
    }

    /**
     * The bytes of one staged file, as raw blob records addressed to an open
     * slot — shared by artifact attachments and share-to-Helm, which differ
     * only in how the slot is opened and committed. Returns null when every
     * slice left the phone, or the reason it could not.
     */
    private suspend fun pumpSlices(
        staged: StagedAttachment,
        offer: UploadOffer,
        onProgress: (Long) -> Unit,
    ): String? {
        val input = client.openStagedAttachment(staged) ?: return HelmClient.STAGE_GONE
        input.use { stream ->
            val buffer = ByteArray(sliceBudget(offer.maxSliceBytes))
            var offset = 0L
            while (offset < staged.sizeBytes) {
                val want = minOf(buffer.size.toLong(), staged.sizeBytes - offset).toInt()
                var filled = 0
                while (filled < want) {
                    val read = stream.read(buffer, filled, want - filled)
                    if (read < 0) break
                    filled += read
                }
                if (filled <= 0) return HelmClient.STAGE_SHORT
                val chunk = if (filled == buffer.size) buffer else buffer.copyOf(filled)
                val last = offset + filled >= staged.sizeBytes
                val frame = MobileEnvelope.encodeBlobUpload(
                    id = offer.uploadId,
                    filename = staged.filename,
                    mimeType = staged.mimeType?.takeIf { it.isNotBlank() } ?: HelmClient.DEFAULT_MIME,
                    offset = offset,
                    total = staged.sizeBytes,
                    eof = last,
                    bytes = chunk,
                )
                val before = client.core.linkPending()
                if (!client.core.send(frame)) return HelmClient.NOT_LINKED
                // Wait for the link to actually carry it before queueing more.
                // The percentage is reported from HERE, never from the send
                // above: over Bluetooth a send only enqueues, so a loop that
                // believed itself would drain a 10MB file into the queue in
                // milliseconds, show 100% at once, and then sit there for the
                // several minutes the radio really takes.
                awaitFlushed(base = offset, sliceBytes = filled, floor = before, onProgress = onProgress)
                offset += filled
                onProgress(offset)
            }
        }
        return null
    }

    /**
     * Share one staged file into [sessionId] (share-to-Helm). The same
     * open → slices → commit chain as an artifact attachment, against the
     * `session_share_file_*` pair: the desktop writes the file to its inbox and
     * sends "Attached: <name> at <path>" to the session's CLI as a phone prompt.
     * Progress and the outcome land on [shares].
     *
     * With [onLanded] it is a CHAT attachment instead: the commit sends `draft:false`
     * (nothing sent to the CLI), and the desktop path is handed back for the
     * composer to carry.
     */
    fun shareFile(
        sessionId: String,
        sessionName: String,
        staged: StagedAttachment,
        onLanded: ((path: String) -> Unit)? = null,
    ): Boolean {
        val attemptId = synchronized(shareLock) { ++shareSequence }
        if (!client.shares.start(attemptId, staged.sizeBytes)) return false
        val active = ActiveShare(attemptId, sessionName, onLanded)
        synchronized(shareLock) {
            activeShare = active
            active.waitPrompt = client.core.scheduler.schedule(HelmClient.SHARE_WAIT_PROMPT_MS) {
                client.shares.askToContinue(attemptId)
            }
        }
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            "filename" to staged.filename,
            "sizeBytes" to staged.sizeBytes,
            "sha256" to staged.sha256,
        )
        staged.mimeType?.takeIf { it.isNotBlank() }?.let { params["contentType"] = it }
        val issued = client.core.call(HelmClient.METHOD_SESSION_SHARE_FILE_ADD, params, requestDeadlineMs = null) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    val offer = uploadOffer(outcome.result)
                    if (offer == null) {
                        failShare(active, HelmClient.UNREADABLE_UPLOAD_OFFER)
                    } else {
                        val shouldCancel = synchronized(shareLock) {
                            if (activeShare !== active) return@call
                            active.offer = offer
                            active.cancelRequested
                        }
                        if (shouldCancel) {
                            cancelRemoteShare(active, offer)
                        } else {
                            val job = client.core.uploadScope.launch { streamShare(active, staged, offer) }
                            synchronized(shareLock) {
                                if (activeShare === active && !active.cancelRequested) active.job = job
                                else job.cancel()
                            }
                        }
                    }
                }
                is HelmClient.Outcome.Failed -> failShare(active, outcome.message)
            }
        }
        if (!issued) failShare(active, HelmClient.NOT_LINKED)
        return issued
    }

    private suspend fun streamShare(
        active: ActiveShare,
        staged: StagedAttachment,
        offer: UploadOffer,
    ) {
        try {
            val failure = pumpSlices(staged, offer) { sent -> client.shares.progress(active.attemptId, sent) }
            if (failure != null) {
                cancelRemoteShare(active, offer)
                failShare(active, failure)
                return
            }
            val params = linkedMapOf<String, Any>("uploadId" to offer.uploadId)
            if (active.onLanded != null) params["draft"] = false
            val issued = client.core.call(
                HelmClient.METHOD_SESSION_SHARE_FILE_COMMIT,
                params,
                requestDeadlineMs = null,
            ) { outcome ->
                when (outcome) {
                    is HelmClient.Outcome.Ok -> finishShareSuccess(active, outcome.result)
                    is HelmClient.Outcome.Failed -> failShare(active, outcome.message)
                }
            }
            if (!issued) failShare(active, HelmClient.NOT_LINKED)
        } catch (cancelled: CancellationException) {
            val requested = synchronized(shareLock) { active.cancelRequested }
            if (!requested) {
                cancelRemoteShare(active, offer)
                failShare(active, HelmClient.LINK_LOST)
            }
        } catch (failure: Exception) {
            cancelRemoteShare(active, offer)
            failShare(active, failure.message ?: HelmClient.SHARE_FAILED)
        }
    }

    /** Continue is UI-only: the same upload request keeps running. */
    fun continueShareWait(attemptId: Long) {
        client.shares.continueWaiting(attemptId)
    }

    /** Stop the local pump and ask Helm to drop the slot (or report a racing commit). */
    fun cancelShare(attemptId: Long) {
        val active = synchronized(shareLock) {
            activeShare?.takeIf { it.attemptId == attemptId && !it.cancelRequested }?.also {
                it.cancelRequested = true
                it.job?.cancel()
                client.shares.cancelling(attemptId)
            }
        } ?: return
        active.offer?.let { cancelRemoteShare(active, it) }
    }

    private fun cancelRemoteShare(active: ActiveShare, offer: UploadOffer) {
        val issue = synchronized(shareLock) {
            if (activeShare !== active || active.cancelRequestPending) false
            else {
                active.cancelRequestPending = true
                true
            }
        }
        if (!issue) return

        client.core.call(
            HelmClient.METHOD_SESSION_SHARE_FILE_CANCEL,
            linkedMapOf("uploadId" to offer.uploadId),
            requestDeadlineMs = null,
        ) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Failed -> failShare(active, outcome.message)
                is HelmClient.Outcome.Ok -> {
                    val result = client.core.json(outcome.result)
                    val receipt = result?.optJSONObject("receipt")
                    if (result?.optBoolean("committed") == true && receipt != null) {
                        finishShareSuccess(active, receipt)
                    } else {
                        finishShareCancelled(active)
                    }
                }
            }
        }
    }

    private fun finishShareSuccess(active: ActiveShare, result: Any?) {
        val path = client.core.json(result)?.opt("path") as? String
        client.shares.done(active.attemptId, active.sessionName)
        path?.let { active.onLanded?.invoke(it) }
        retireShare(active)
    }

    private fun finishShareCancelled(active: ActiveShare) {
        client.shares.cancelled(active.attemptId)
        retireShare(active)
    }

    private fun failShare(active: ActiveShare, message: String) {
        client.shares.failed(active.attemptId, message)
        retireShare(active)
    }

    private fun retireShare(active: ActiveShare) {
        synchronized(shareLock) {
            if (activeShare === active) {
                active.waitPrompt?.cancel()
                activeShare = null
            }
        }
    }

    /**
     * Block until the slice just sent has left the phone, reporting what has
     * really gone as it drains.
     *
     * [floor] is what was already pending before the slice was handed over, so
     * the wait is for THIS slice and not for the queue to reach zero. The
     * reported figure interpolates inside the slice: a slice is up to a megabyte
     * and a Bluetooth link takes minutes over one, so a bar that moved only at
     * slice boundaries would be indistinguishable from a frozen one.
     *
     * POLLED rather than pushed. A drained-to-here callback would have to be
     * threaded from the GATT queue through HelmLink to here, fire on a binder
     * thread, and be unsubscribed on every failure path — all to learn a number
     * that is already readable. The cost is one cheap read per tick of a
     * transfer measured in minutes.
     *
     * Returns when the slice is gone OR when the link discarded its queue (a
     * dropped link empties it): both leave nothing of this slice pending, and
     * the commit that follows is what tells the user which one happened.
     */
    private suspend fun awaitFlushed(base: Long, sliceBytes: Int, floor: Long, onProgress: (Long) -> Unit) {
        val queued = (client.core.linkPending() - floor).coerceAtLeast(0L)
        // Nothing waiting means the transport flushes as it sends — LAN does —
        // and there is nothing to wait for.
        if (queued <= 0L) return
        while (true) {
            pause(HelmClient.FLUSH_POLL_MS)
            val outstanding = (client.core.linkPending() - floor).coerceAtLeast(0L)
            if (outstanding <= 0L) return
            val gone = (queued - outstanding) * sliceBytes / queued
            onProgress(base + gone)
        }
    }

    /**
     * Sleep on the class's OWN clock — [scheduler] — rather than on `delay`.
     *
     * Every other deadline here is already the scheduler's, so a test that can
     * drive a call timeout can drive this too, and the pacing loop above stays
     * as testable as the rest of the file instead of needing wall time.
     */
    private suspend fun pause(delayMs: Long) = suspendCancellableCoroutine { continuation ->
        val armed = client.core.scheduler.schedule(delayMs) { continuation.resume(Unit) }
        continuation.invokeOnCancellation { armed.cancel() }
    }

    /** The whole stage landed: NOW the edit moves the user, like a bare one would. */
    private fun finishArtifactUploads(sessionId: String, artifactId: String) {
        if (landOnFinish) client.control.artifactLanded(uploadAction, artifactId)
        client.refreshArtifacts(sessionId)
    }

    /** A slot-open answer: `{uploadId, maxSliceBytes, total}`. */
    private fun uploadOffer(result: Any?): UploadOffer? {
        client.core.json(result)?.let { json ->
            val uploadId = json.opt("uploadId") as? String ?: return null
            val maxSlice = (json.opt("maxSliceBytes") as? Number)?.toLong() ?: return null
            val total = (json.opt("total") as? Number)?.toLong() ?: return null
            return UploadOffer(uploadId, maxSlice, total)
        }
        return null
    }

    /**
     * The committed attachment's id. The commit answer is
     * `{artifactId, attachment:{id,…}}`; the attachment id is all this app does
     * with it, and an answer of an unexpected shape still counts as DONE — the
     * desktop verified the bytes, which is what the chip is claiming.
     */
    private fun attachmentIdIn(result: Any?): String =
        client.core.json(result)?.let { json ->
            (json.optJSONObject("attachment")?.opt("id") as? String)
                ?: (json.opt("id") as? String)
        }.orEmpty()

    /** The offer clipped to what this phone will put in one frame. */
    private fun sliceBudget(advertised: Long): Int =
        minOf(advertised, HelmClient.MAX_UPLOAD_SLICE_BYTES.toLong()).toInt().coerceIn(1, HelmClient.MAX_FRAME_BYTES)
}
