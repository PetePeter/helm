package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactRepository
import com.potatomotato.helm.data.ArtifactUploads
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.attachmentSliceBytes
import com.potatomotato.helm.data.CapabilityCache
import com.potatomotato.helm.data.AttachmentPulls
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.PullTarget
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.ContextRepository
import com.potatomotato.helm.data.ControlRepository
import com.potatomotato.helm.data.PlanRepository
import com.potatomotato.helm.data.SequenceRepository
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionRepository
import com.potatomotato.helm.data.SessionWire
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.RANK_LAN
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.notify.AlertRouter
import com.potatomotato.helm.save.SavedFile
import com.potatomotato.helm.wire.MobileEnvelope
import com.potatomotato.helm.data.ArtifactRules

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

import org.json.JSONObject
import com.potatomotato.helm.wire.MobileRecord

/**
 * HelmClient — what the phone DOES with an authenticated link.
 *
 * It sits directly on [PairingController]'s inbound seam and owns exactly one
 * piece of state the layers around it cannot: which outstanding call each
 * `result` or `error` belongs to. Everything else it hands to a repository.
 *
 * ```mermaid
 * graph LR
 *     PC[PairingController] -->|plaintext| HC[HelmClient]
 *     HC -->|result| SR[SessionRepository]
 *     HC -->|chat| CR[ChatRepository]
 *     HC -->|chat with a kind| AR[AlertRouter]
 *     HC -->|call| PC
 * ```
 *
 * Deliberately free of Android types: the correlation, the bounded pending map
 * and the failure paths are the parts worth testing, and they test on the JVM.
 *
 * Note what is NOT here — a privileged path. A chat reply is a `session_send_text`
 * CALL like any other, so it passes MobileGate, the rate limit and the audit
 * exactly as a tool invocation does. That is what makes "no path skips the gate"
 * structural rather than a promise.
 */
class HelmClient(
    /** Returns false when there is no authenticated link to carry the bytes. */
    private val send: (ByteArray) -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
    private val scheduler: ChannelScheduler,
    /**
     * Bytes the link has taken but not yet put on the wire — the backpressure
     * an upload paces itself against. See [HelmLink.pendingBytes] for why the
     * link has to be asked rather than inferred from [send]'s return value.
     */
    private val linkPending: () -> Long = { HelmLink.pendingBytes },
    /**
     * Where a file's slices are pumped. Its own scope, because that pump is the
     * one thing here that BLOCKS: it waits on the radio between slices, and the
     * inbound path it used to run on must never wait for anything.
     */
    private val uploadScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    val sessions: SessionRepository = SessionRepository(),
    val chats: ChatRepository = ChatRepository(),
    val capabilities: CapabilityCache = CapabilityCache(),
    val control: ControlRepository = ControlRepository(),
    val artifacts: ArtifactRepository = ArtifactRepository(),
    val plans: PlanRepository = PlanRepository(),
    val sequences: SequenceRepository = SequenceRepository(),
    val contexts: ContextRepository = ContextRepository(),
    val alerts: AlertRouter = AlertRouter(),
    val uploads: ArtifactUploads = ArtifactUploads(),
) {
    /**
     * Where a pushed LAN address list lands (P-0752).
     *
     * A settable port rather than a constructor argument, for the same reason
     * [alerts] has one: the store needs a Context, and this client is built
     * before one exists. Defaults to discarding, so a build that never wires it
     * simply never dials — which is exactly the pre-LAN behaviour.
     */
    var onLanAddresses: (List<String>) -> Unit = {}

    /**
     * This phone's machineId — the prefix the desktop puts on an echoed reply's
     * `originId` (see [MobileRecord.Chat.originId]). Settable like
     * [onLanAddresses] for the same reason: the identity needs a Context, and
     * this client is built before one exists. Empty means the echo-matching is
     * off, which costs nothing but a duplicate row in a build that never wires it.
     */
    var machineId: String = ""

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

    /** Outstanding calls, oldest first, each with a deadline that owns its cleanup. */
    private val pending = LinkedHashMap<String, PendingCall>()
    private var sequence = 0L
    private var sessionRefreshInFlight = false
    private var sessionRefreshQueued = false

    /**
     * Whether the chat cursor has been reported on THIS link. The report rides
     * the link-up hook first, but the hook is not guaranteed: after a failed
     * handshake attempt the relink that follows can come up usable without
     * `onLinked` ever firing (observed on real hardware — `__mobile_tools__`
     * crosses, `__chat_cursor__` never does), and the threads stay empty for
     * the whole process. The session poll is the one request that demonstrably
     * runs whenever the link is usable, so an unreported cursor re-sends there
     * within one interval. A duplicate report is harmless: the desktop replays
     * from the same seq and [ChatRepository] dedupes by seq.
     *
     * The report also goes STALE after [CURSOR_REPORT_FRESH_MS]: a journal
     * replay streamed over BLE can outrun a link that drops mid-stream, and the
     * desktop — having answered the report — never sends the rest. Saying the
     * cursor again after five minutes heals that hole on the next poll instead
     * of at the next app restart, for the cost of a replay [ChatRepository]
     * dedupes to nothing.
     */
    private var chatCursorReported = false

    /** When [now] last stamped the report as issued — the freshness clock. */
    private var chatCursorReportedAt = 0L

    private data class PendingCall(
        val onOutcome: (Outcome) -> Unit,
        val deadline: Cancellable,
    )

    /** A desktop's answer to a slot-open: where to send the bytes and how big a slice may be. */
    private data class UploadOffer(
        val uploadId: String,
        val maxSliceBytes: Long,
        val total: Long,
    )

    /** How a call ended. A denial and a dead link are both [Failed] — by design. */
    sealed interface Outcome {
        data class Ok(val result: Any?) : Outcome
        data class Failed(val message: String) : Outcome
    }

    /**
     * Ask for the session list. At most one request crosses the link at a time;
     * callers that arrive while it waits ask for one reconciliation afterward.
     */
    fun refreshSessions(): Boolean {
        reportChatCursorIfNeeded()
        if (sessionRefreshInFlight) {
            sessionRefreshQueued = true
            return true
        }
        sessionRefreshInFlight = true
        return call(METHOD_SESSION_LIST) { outcome ->
            sessionRefreshInFlight = false
            try {
                // A failed refresh leaves the previous list standing: stale data
                // is more useful than an empty lie.
                if (outcome !is Outcome.Ok) {
                    if ((outcome as Outcome.Failed).message == MOBILE_DENY_MESSAGE) sessions.denied()
                    return@call
                }
                val parsed = SessionWire.parseList(outcome.result)
                if (parsed == null) {
                    HelmLog.w(HelmLog.CLIENT, "session_list answered ok but did not decode; the list is unchanged")
                    sessions.undecodable()
                    return@call
                }
                HelmLog.i(
                    HelmLog.CLIENT,
                    "session_list decoded ${parsed.size} sessions; " +
                        "the list held ${sessions.sessions.value.size} before the merge",
                )
                sessions.applySnapshot(parsed)
                HelmLog.i(HelmLog.CLIENT, "the list holds ${sessions.sessions.value.size} after the merge")
            } finally {
                // A queued poll is reconciliation, not a retry of only success.
                refreshQueuedSessions()
            }
        }
    }

    /**
     * Reply into a session. The message appears immediately and is settled when
     * the call comes back, so the user can see the difference between "sent" and
     * "the desktop never answered".
     */
    fun sendChat(sessionId: String, text: String): Boolean =
        issueText(sessionId, text, key = chats.sending(sessionId, text, now()))

    /**
     * Send a FAILED message again — the ↻ under the bubble.
     *
     * The repository swaps the dead attempt for a fresh optimistic one (a retry
     * is a new arrival, not a resurrection of the old row), and the wire ask
     * settles THAT new message: the bubble the user pressed is already gone, so
     * there is never a moment with two rows both claiming to be in flight.
     * [text] comes from the bubble the retry was pressed on; the repository
     * remains the authority on whether the attempt really failed.
     */
    fun resendChat(sessionId: String, key: String, text: String): Boolean {
        val newKey = chats.retry(sessionId, key, now()) ?: return false
        return issueText(sessionId, text, key = newKey)
    }

    /** One `session_send_text` ask, settling the optimistic row named by [key]. */
    private fun issueText(sessionId: String, text: String, key: String): Boolean {
        val params = linkedMapOf("sessionId" to sessionId, "text" to text)
        // The call id is chosen HERE rather than inside [call] because the
        // desktop derives the echo's originId from it — this end must know it to
        // recognise its own words when the journal replays them back.
        val id = nextCallId()
        val issued = call(METHOD_SESSION_SEND_TEXT, params, id = id) { outcome ->
            chats.settle(sessionId, key, outcome is Outcome.Ok)
        }
        if (issued) {
            // Only a call the link actually carried is registered: the desktop
            // journals only what it accepted, so claiming an echo for an unsent
            // call would drop somebody else's history.
            chats.sent("$machineId:$id")
        } else {
            chats.settle(sessionId, key, delivered = false)
        }
        return issued
    }

    /**
     * Ask the gate what this device may do. The answer drives the greying on the
     * control sheet, so it is asked for rather than assumed — a hardcoded list
     * would eventually claim a permission the desktop had revoked.
     */
    fun refreshCapabilities(): Boolean = call(METHOD_MOBILE_TOOLS) { outcome ->
        // A refused or unanswered discovery leaves the surface UNKNOWN rather
        // than empty: "we could not ask" must not render as "you may not".
        if (outcome is Outcome.Ok) capabilities.apply(outcome.result) else capabilities.forget()
    }

    /**
     * Directories Helm knows about, for the spawn form. A failure is STATE, not
     * a log line: an unanswered fetch used to leave the form hinting "waiting
     * for the directory list" forever, which reads as patience when the truth is
     * the call already died.
     */
    fun refreshDirectories(): Boolean {
        control.directoriesRequested()
        return call(METHOD_DIRECTORY_LIST) { outcome ->
            when (outcome) {
                is Outcome.Ok -> if (!control.directoriesArrived(outcome.result)) {
                    control.directoriesFailed(UNREADABLE_LIST)
                }
                is Outcome.Failed -> control.directoriesFailed(outcome.message)
            }
        }
    }

    /**
     * The full CLI catalogue, for the spawn form. A refused or failed call is
     * left to the form's fallback (harvesting the running sessions) rather than
     * an error state: the fallback is a real feature, not a degraded one.
     */
    fun refreshClis(): Boolean = call(METHOD_TOOL_LIST) { outcome ->
        if (outcome is Outcome.Ok) control.clisArrived(outcome.result)
    }

    /**
     * Pull the terminal tail on demand — never a stream. [lines] is bounded HERE,
     * before any bytes reach the radio: the desktop buffer holds at most
     * [MAX_SNAPSHOT_LINES], and asking for more would spend the link's budget on
     * text that does not exist.
     *
     * The tail is requested `stripped`, so the ANSI cleaning is the desktop's own
     * and this app never grows a second escape-code parser.
     */
    fun readTerminal(sessionId: String, lines: Int): Boolean {
        if (lines !in 1..MAX_SNAPSHOT_LINES) {
            control.snapshotFailed("Ask for 1 to $MAX_SNAPSHOT_LINES lines")
            return false
        }
        control.snapshotRequested(lines)
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            // A NUMBER on the wire. The desktop reads it with a typeof check and
            // silently ignores a quoted one, which would answer the default tail
            // while this screen said otherwise.
            "lines" to lines,
            "mode" to SNAPSHOT_MODE,
            "stripBlankLines" to true,
        )
        val issued = call(METHOD_READ_TERMINAL, params) { outcome ->
            when (outcome) {
                is Outcome.Ok -> control.snapshotArrived(outcome.result, lines)
                is Outcome.Failed -> control.snapshotFailed(outcome.message)
            }
        }
        return issued
    }

    /** Compact a session. Nothing to show but the outcome. */
    fun compact(sessionId: String): Boolean =
        act(SessionAction.Compact, METHOD_SESSION_COMPACT, linkedMapOf("sessionId" to sessionId))

    /**
     * The artifacts of one session, for the artifacts screen. Like the terminal
     * tail, this is PULLED when the screen asks for it, never streamed: the list
     * is a bounded answer and the link's budget belongs to the user's taps.
     */
    fun refreshArtifacts(sessionId: String): Boolean {
        artifacts.listRequested(sessionId)
        return call(METHOD_SESSION_ARTIFACT_LIST, linkedMapOf("sessionId" to sessionId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    // A shape the app cannot read is a failure the screen shows,
                    // never a calm empty list that quietly means "no answer".
                    if (!artifacts.listArrived(sessionId, outcome.result)) {
                        artifacts.listFailed(sessionId, UNREADABLE_ARTIFACTS)
                    }
                is Outcome.Failed -> artifacts.listFailed(sessionId, outcome.message)
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
        artifacts.readRequested(sessionId, artifactId, version)
        val params = linkedMapOf<String, Any>("sessionId" to sessionId, "artifactId" to artifactId)
        if (version != null) params["version"] = version
        return call(METHOD_SESSION_ARTIFACT_GET, params) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!artifacts.readArrived(sessionId, artifactId, version, outcome.result)) {
                        artifacts.readFailed(artifactId, UNREADABLE_ARTIFACT)
                    }
                is Outcome.Failed -> artifacts.readFailed(artifactId, outcome.message)
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
    ): Boolean {
        if (!ArtifactRules.fitsCreate(title, content)) {
            control.noticed(SessionAction.CreateArtifact, ActionOutcome.Failed(TOO_LARGE))
            return false
        }
        return act(
            SessionAction.CreateArtifact,
            METHOD_SESSION_ARTIFACT_CREATE,
            linkedMapOf(
                "sessionId" to sessionId,
                "title" to ArtifactRules.title(title),
                "kind" to CREATE_KIND,
                "content" to content,
            ),
        ) { outcome ->
            if (outcome is Outcome.Ok) {
                val artifactId = idIn(outcome.result)
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
        uploads.beginUploads(artifactId, sessionId)
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
        val next = uploads.pendingKeys().firstOrNull()
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
        val artifactId = uploads.targetArtifactId ?: return false
        val sessionId = uploads.targetSessionId ?: return false
        if (uploads.pendingKeys().isEmpty()) return false
        return sendArtifactAttachment(sessionId, artifactId, uploads.pendingKeys().first())
    }

    /**
     * One file's chain, first half: open a slot on the desktop. The offer that
     * comes back names the slot the raw slices address — the slices carry NO
     * session, artifact or filename authority beyond that id, which is why the
     * desktop can refuse a slice from any other device without guessing.
     */
    private fun sendArtifactAttachment(sessionId: String, artifactId: String, key: String): Boolean {
        val staged = uploads.stagedAttachment(key)
        if (staged == null) {
            uploads.uploadFailed(key, STAGE_GONE)
            return false
        }
        uploads.uploadStarted(key, staged.sizeBytes)
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            "artifactId" to artifactId,
            "filename" to staged.filename,
            "sizeBytes" to staged.sizeBytes,
            "sha256" to staged.sha256,
        )
        staged.mimeType?.takeIf { it.isNotBlank() }?.let { params["contentType"] = it }
        return call(METHOD_SESSION_ARTIFACT_ATTACHMENT_ADD, params) { outcome ->
            when (outcome) {
                is Outcome.Ok -> {
                    val offer = uploadOffer(outcome.result)
                    if (offer == null) {
                        uploads.uploadFailed(key, UNREADABLE_UPLOAD_OFFER)
                    } else {
                        streamArtifactUpload(sessionId, artifactId, key, staged, offer)
                    }
                }
                is Outcome.Failed -> uploads.uploadFailed(key, outcome.message)
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
        uploadScope.launch { streamArtifactUploadSlices(sessionId, artifactId, key, staged, offer) }
    }

    private suspend fun streamArtifactUploadSlices(
        sessionId: String,
        artifactId: String,
        key: String,
        staged: StagedAttachment,
        offer: UploadOffer,
    ) {
        val input = openStagedAttachment(staged)
        if (input == null) {
            uploads.uploadFailed(key, STAGE_GONE)
            return
        }
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
                if (filled <= 0) {
                    uploads.uploadFailed(key, STAGE_SHORT)
                    return
                }
                val chunk = if (filled == buffer.size) buffer else buffer.copyOf(filled)
                val eof = offset + filled >= staged.sizeBytes
                val frame = MobileEnvelope.encodeBlobUpload(
                    id = offer.uploadId,
                    filename = staged.filename,
                    mimeType = staged.mimeType?.takeIf { it.isNotBlank() } ?: DEFAULT_MIME,
                    offset = offset,
                    total = staged.sizeBytes,
                    eof = eof,
                    bytes = chunk,
                )
                val before = linkPending()
                if (!send(frame)) {
                    uploads.uploadFailed(key, NOT_LINKED)
                    return
                }
                // Wait for the link to actually carry it before queueing more.
                // The percentage is reported from HERE, never from the send
                // above: over Bluetooth a send only enqueues, so a loop that
                // believed itself would drain a 10MB file into the queue in
                // milliseconds, show 100% at once, and then sit there for the
                // several minutes the radio really takes.
                awaitFlushed(key, base = offset, sliceBytes = filled, floor = before)
                offset += filled
                uploads.uploadProgress(key, offset)
            }
        }
        // One file's chain, last half: the commit. The desktop verifies the size
        // and the sha256 declared at slot-open against what actually arrived —
        // the slices themselves are silent, so this is the only moment the
        // phone learns whether the file exists on the other end.
        val issued = call(
            METHOD_SESSION_ARTIFACT_ATTACHMENT_COMMIT,
            linkedMapOf("uploadId" to offer.uploadId),
        ) { outcome ->
            when (outcome) {
                is Outcome.Ok -> {
                    uploads.uploadDone(key, attachmentIdIn(outcome.result))
                    startArtifactUploads(sessionId, artifactId)
                }
                is Outcome.Failed -> uploads.uploadFailed(key, outcome.message)
            }
        }
        // A commit the link refused to carry fails the chip here rather than
        // leaving it Uploading against a slot the desktop will evict.
        if (!issued) uploads.uploadFailed(key, NOT_LINKED)
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
    private suspend fun awaitFlushed(key: String, base: Long, sliceBytes: Int, floor: Long) {
        val queued = (linkPending() - floor).coerceAtLeast(0L)
        // Nothing waiting means the transport flushes as it sends — LAN does —
        // and there is nothing to wait for.
        if (queued <= 0L) return
        while (true) {
            pause(FLUSH_POLL_MS)
            val outstanding = (linkPending() - floor).coerceAtLeast(0L)
            if (outstanding <= 0L) return
            val gone = (queued - outstanding) * sliceBytes / queued
            uploads.uploadProgress(key, base + gone)
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
        val armed = scheduler.schedule(delayMs) { continuation.resume(Unit) }
        continuation.invokeOnCancellation { armed.cancel() }
    }

    /** The whole stage landed: NOW the edit moves the user, like a bare one would. */
    private fun finishArtifactUploads(sessionId: String, artifactId: String) {
        control.artifactLanded(uploadAction, artifactId)
        refreshArtifacts(sessionId)
    }

    /**
     * Append a version to an artifact the session owns. No title rides the wire
     * (`session_artifact_update` takes content only) and no follow-up ask is
     * made: returning to the detail screen re-pulls the body the way every
     * visit does, and that re-pull is the reconciliation.
     *
     * Staged files ride a revise exactly as they ride a create — the artifact
     * already exists, so the chain can start the moment the update is
     * acknowledged.
     */
    fun reviseArtifact(
        sessionId: String,
        artifactId: String,
        content: String,
        attachmentKeys: List<String> = emptyList(),
    ): Boolean {
        if (!ArtifactRules.fitsRevise(content)) {
            control.noticed(SessionAction.ReviseArtifact, ActionOutcome.Failed(TOO_LARGE))
            return false
        }
        return act(
            SessionAction.ReviseArtifact,
            METHOD_SESSION_ARTIFACT_UPDATE,
            linkedMapOf("sessionId" to sessionId, "artifactId" to artifactId, "content" to content),
        ) { outcome ->
            if (outcome is Outcome.Ok) {
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
        act(
            SessionAction.DeleteArtifact,
            METHOD_SESSION_ARTIFACT_DELETE,
            linkedMapOf("sessionId" to sessionId, "artifactId" to artifactId),
        ) { outcome ->
            if (outcome is Outcome.Ok) control.artifactLanded(SessionAction.DeleteArtifact, artifactId)
        }

    /**
     * Fetch one artifact as a FILE — `{filename, mimeType, base64, …}` — rather
     * than inline content. The outcome is deliberately NOT noticed on `Ok`: the
     * bytes have not been saved yet, and the notice that says "saved" waits for
     * the device sink. A refusal or a dead link IS noticed like any other
     * action, because those are verdicts the user must be able to read.
     */
    fun downloadArtifact(sessionId: String, artifactId: String, version: Int? = null): Boolean {
        artifacts.downloadRequested(artifactId)
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
    ): Boolean = pullAttachment(
        sessionId,
        artifacts.attachmentPulls,
        PullTarget(
            key = artifactAttachmentKey(artifactId, attachment.id),
            artifactId = artifactId,
            attachmentId = attachment.id,
            filename = attachment.filename,
            // The desktop's content type is a hint it may never have had; a file
            // with no type still saves, as the generic one.
            mimeType = attachment.contentType?.takeIf { it.isNotBlank() } ?: DEFAULT_MIME,
            sizeBytes = attachment.sizeBytes,
        ),
    )

    /**
     * Where a pulled chat attachment is written, and what to call the place it
     * landed. A settable port for the same reason [onLanAddresses] is one: the
     * device sink needs a Context and this client is built before there is one.
     * The default refuses, so a build that never wires it fails legibly on the
     * tile rather than pretending to have saved something.
     */
    var saveAttachment: (filename: String, mimeType: String, bytes: ByteArray) -> SavedFile = { _, _, _ ->
        throw IllegalStateException(NO_FILE_SINK)
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
        if (!pulls.pullStarted(target.key, target.sizeBytes)) return false
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
    ): Boolean = call(
        METHOD_SESSION_ARTIFACT_DOWNLOAD,
        linkedMapOf(
            "sessionId" to sessionId,
            "artifactId" to target.artifactId,
            "attachmentId" to target.attachmentId,
            "offset" to offset,
            "length" to sliceBytes,
        ),
    ) { outcome ->
        when (outcome) {
            is Outcome.Ok -> takeSlice(sessionId, pulls, target, offset, outcome.result)
            is Outcome.Failed -> pulls.pullFailed(target.key, outcome.message)
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
            pulls.pullFailed(target.key, UNREADABLE_DOWNLOAD)
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
            val saved = saveAttachment(name, target.mimeType, whole)
            pulls.pullSaved(target.key, saved.location, saved.uri)
        } catch (error: Exception) {
            HelmLog.w(HelmLog.CLIENT, "a pulled attachment could not be written to storage")
            pulls.pullFailed(target.key, error.message ?: NO_FILE_SINK)
        }
    }

    /**
     * Bin ONE attachment without binning the artifact that holds it. The tile
     * goes with it; a file the desktop no longer has is not one to offer.
     */
    fun deleteChatAttachment(sessionId: String, key: String, attachment: ChatAttachment): Boolean =
        act(
            SessionAction.DeleteArtifact,
            METHOD_SESSION_ARTIFACT_ATTACHMENT_DELETE,
            linkedMapOf(
                "sessionId" to sessionId,
                "artifactId" to attachment.artifactId,
                "attachmentId" to attachment.attachmentId,
            ),
        ) { outcome ->
            if (outcome is Outcome.Ok) chats.remove(sessionId, key)
        }

    /** One `session_artifact_download` ask; [artifactId] is who the answer belongs to. */
    private fun fetchArtifactFile(artifactId: String, params: Map<String, Any>): Boolean =
        call(METHOD_SESSION_ARTIFACT_DOWNLOAD, params) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!artifacts.downloadArrived(artifactId, outcome.result)) {
                        artifacts.downloadFailed(artifactId, UNREADABLE_DOWNLOAD)
                    }
                is Outcome.Failed -> {
                    control.noticed(SessionAction.SaveArtifact, outcomeFor(outcome))
                    artifacts.downloadFailed(artifactId, outcome.message)
                }
            }
        }

    /**
     * Rename a session. The list is the only place the new name shows, so success
     * pulls it the way a close does; the notice bar says the rest.
     */
    fun renameSession(sessionId: String, newName: String): Boolean =
        act(SessionAction.Rename, METHOD_SESSION_RENAME, linkedMapOf("sessionId" to sessionId, "newName" to newName)) { outcome ->
            if (outcome is Outcome.Ok) refreshSessions()
        }

    /**
     * Close a session. Expect a refusal for anything this phone did not create:
     * the gate lets a device close only its own sessions, and the permitted-tools
     * cache cannot see that rule. The refusal is reported as a rule, not a fault.
     */
    fun closeSession(sessionId: String): Boolean =
        act(SessionAction.Close, METHOD_SESSION_CLOSE, linkedMapOf("sessionId" to sessionId)) { outcome ->
            if (outcome is Outcome.Ok) refreshSessions()
        }

    /**
     * Spawn a session. The one CREATING action, and the only one this phone
     * will then own.
     *
     * A blank name is OMITTED from the wire rather than sent empty:
     * `session_create` treats the name as optional and the desktop names the
     * session after the CLI type. The created session id is recorded on success
     * so the UI can open the thread; everything else about the outcome is the
     * notice bar's to say.
     */
    fun spawn(dirPath: String, cliType: String, name: String): Boolean {
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "cliType" to cliType)
        if (name.isNotBlank()) params["name"] = name.trim()
        control.spawnStarted()
        return act(SessionAction.Spawn, METHOD_SESSION_CREATE, params) { outcome ->
            // Every outcome path settles — act() delivers the verdict whatever it
            // was, including the no-link failure that answers before anything was
            // sent — so the flag cannot outlive the tap that raised it.
            control.spawnSettled()
            if (outcome is Outcome.Ok) {
                control.spawnCreated(idIn(outcome.result))
                refreshSessions()
            }
        }
    }

    // ------------------------------------------------- plans, sequences, contexts

    /**
     * The plans of one directory as BOARD ROWS — `plan_summary`, never the
     * full-record list. The summary carries status, ids, title and edges and
     * leaves every description behind, which is what keeps the answer small
     * enough for this link to finish delivering it. The prose arrives one plan
     * at a time from [readPlan] when the reader opens one.
     *
     * READ-ONLY on this link for now — nothing here creates, claims or completes
     * a plan — so a refusal is state the screen shows and never a half-written
     * change on the desktop.
     *
     * ACTIVE IS FIXED, not a parameter: a finished plan is noise on a phone, and
     * asking for all of them is what cost the link the reply in the first place.
     */
    fun refreshPlans(dirPath: String): Boolean {
        plans.listRequested(dirPath)
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "filter" to FILTER_ACTIVE)
        return call(METHOD_PLAN_SUMMARY, params) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!plans.listArrived(dirPath, outcome.result)) {
                        plans.listFailed(dirPath, UNREADABLE_PLANS)
                    }
                is Outcome.Failed -> plans.listFailed(dirPath, outcome.message)
            }
        }
    }

    /**
     * One plan in full. The id rides as `uuid`, which is the only form the
     * desktop's `plan_get` takes — a P-00xx humanId would be refused, and the
     * board already holds the UUID for every row it drew.
     */
    fun readPlan(planId: String): Boolean {
        plans.detailRequested(planId)
        return call(METHOD_PLAN_GET, linkedMapOf("uuid" to planId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!plans.detailArrived(planId, outcome.result)) {
                        plans.detailFailed(planId, UNREADABLE_PLAN)
                    }
                is Outcome.Failed -> plans.detailFailed(planId, outcome.message)
            }
        }
    }

    /**
     * One plan's effective context refs — its own bindings merged with those
     * inherited from its sequence. Refs only: the bodies are a `context_get`
     * away, fetched when the reader opens one, which is why this answer stays
     * small enough to pull on every visit.
     */
    fun refreshPlanContexts(planId: String): Boolean {
        plans.contextRefsRequested(planId)
        return call(METHOD_PLAN_CONTEXT_LIST, linkedMapOf("planId" to planId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!plans.contextRefsArrived(planId, outcome.result)) {
                        plans.contextRefsFailed(planId, UNREADABLE_PLAN_CONTEXTS)
                    }
                is Outcome.Failed -> plans.contextRefsFailed(planId, outcome.message)
            }
        }
    }

    /**
     * The sequence lanes of one directory, including the member plan ids the
     * desktop computes per answer. `sequence_list` also accepts a `planId`; only
     * the directory form is sent, because the board groups a whole directory and
     * asking per plan would be one call per row.
     */
    fun refreshSequences(dirPath: String): Boolean {
        sequences.listRequested(dirPath)
        return call(METHOD_SEQUENCE_LIST, linkedMapOf("dirPath" to dirPath)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!sequences.listArrived(dirPath, outcome.result)) {
                        sequences.listFailed(dirPath, UNREADABLE_SEQUENCES)
                    }
                is Outcome.Failed -> sequences.listFailed(dirPath, outcome.message)
            }
        }
    }

    /** One sequence lane in full. The id rides as `id`, as `sequence_get` takes it. */
    fun readSequence(sequenceId: String): Boolean {
        sequences.detailRequested(sequenceId)
        return call(METHOD_SEQUENCE_GET, linkedMapOf("id" to sequenceId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!sequences.detailArrived(sequenceId, outcome.result)) {
                        sequences.detailFailed(sequenceId, UNREADABLE_SEQUENCE)
                    }
                is Outcome.Failed -> sequences.detailFailed(sequenceId, outcome.message)
            }
        }
    }

    /**
     * The projects Helm tracks. A BARE call — `project_list` takes no arguments —
     * and the prerequisite for every context ask, since a context node is
     * addressed by its project.
     */
    fun refreshProjects(): Boolean {
        contexts.projectsRequested()
        return call(METHOD_PROJECT_LIST) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!contexts.projectsArrived(outcome.result)) {
                        contexts.projectsFailed(UNREADABLE_PROJECTS)
                    }
                is Outcome.Failed -> contexts.projectsFailed(outcome.message)
            }
        }
    }

    /** The context nodes of one project, bodies included — the desktop's list carries them. */
    fun refreshContexts(projectId: String): Boolean {
        contexts.listRequested(projectId)
        return call(METHOD_CONTEXT_LIST, linkedMapOf("projectId" to projectId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!contexts.listArrived(projectId, outcome.result)) {
                        contexts.listFailed(projectId, UNREADABLE_CONTEXTS)
                    }
                is Outcome.Failed -> contexts.listFailed(projectId, outcome.message)
            }
        }
    }

    /**
     * One context node in full. Asked for even though the list carries content,
     * because a ref from `plan_context_list` names a node the project list may
     * not have been pulled for — a ref is an id, not a row.
     */
    fun readContext(contextId: String): Boolean {
        contexts.detailRequested(contextId)
        return call(METHOD_CONTEXT_GET, linkedMapOf("id" to contextId)) { outcome ->
            when (outcome) {
                is Outcome.Ok ->
                    if (!contexts.detailArrived(contextId, outcome.result)) {
                        contexts.detailFailed(contextId, UNREADABLE_CONTEXT)
                    }
                is Outcome.Failed -> contexts.detailFailed(contextId, outcome.message)
            }
        }
    }

    /** One decrypted application message. Never throws: the link outlives its payloads. */
    fun onInbound(payload: ByteArray) {
        val record = MobileEnvelope.decode(payload)
        if (record == null) {
            HelmLog.w(HelmLog.WIRE, "dropped an inbound record of ${payload.size} bytes: it did not decode")
            return
        }
        HelmLog.d(HelmLog.WIRE) { "inbound ${record.javaClass.simpleName} of ${payload.size} bytes" }
        when (record) {
            is MobileRecord.Result -> settle(record.id, Outcome.Ok(record.result))
            // A download's answer. Correlated and settled exactly like a result —
            // the caller that asked knows it asked for bytes.
            is MobileRecord.Blob -> settle(record.id, Outcome.Ok(record))
            is MobileRecord.Failure -> settle(record.id, Outcome.Failed(record.message))
            // THE ONE place a chat record is split. A kind-bearing record is an
            // EVENT Helm is reporting, not something an agent said: routing it
            // into the thread would grow a conversation the desktop never had,
            // and the drift would be invisible from the desktop side.
            // A kind-less record goes to BOTH: the thread is where it lives, and
            // the notification is how the user finds out it arrived while they
            // were elsewhere. It is one message told once on two surfaces, the
            // same shape as the ratified Telegram/app duplication.
            is MobileRecord.Chat ->
                if (record.kind == null) {
                    chats.receive(record)
                    alerts.onMessage(record)
                } else {
                    alerts.onAlert(record)
                }

            // Where this desktop can be reached over the network. Accepted ONLY
            // here, from the authenticated channel — an address learned any
            // other way is an invitation to dial someone else. An EMPTY list is
            // honoured as "stop dialling", which is how the desktop turning LAN
            // off reaches a phone that is connected right now.
            is MobileRecord.Lan -> onLanAddresses(record.addresses)

            // A `call` inbound is Helm asking the PHONE to do something, which it
            // never does — the phone has no gate of its own to answer through.
            // Dropped, but no longer in silence: silence is what this plan exists
            // to end, and a desktop that starts calling the phone is worth seeing.
            is MobileRecord.Call ->
                HelmLog.w(HelmLog.CLIENT, "dropped an inbound call for ${record.method}; the phone answers none")
        }
    }

    /**
     * Hand one answer to the call that asked for it.
     *
     * An id with nothing waiting is ORPHANED — the answer to a call the link
     * already failed, or one evicted for age. It is dropped either way, but it
     * is logged, because a screen that stays empty while answers arrive and go
     * nowhere is precisely the failure nobody could see.
     */
    private fun settle(id: String, outcome: Outcome) {
        val waiting = pending.remove(id)
        if (waiting == null) {
            HelmLog.w(HelmLog.CLIENT, "ORPHANED answer for call $id; no call is waiting on it")
            return
        }
        waiting.deadline.cancel()
        HelmLog.d(HelmLog.CLIENT) {
            "call $id settled as ${if (outcome is Outcome.Ok) "ok" else "failed"}; ${pending.size} still pending"
        }
        waiting.onOutcome(outcome)
    }


    /** Everything outstanding fails when the link goes. Nothing waits forever. */
    fun onLinkLost() {
        val abandoned = pending.values.toList()
        if (abandoned.isNotEmpty()) {
            HelmLog.w(HelmLog.CLIENT, "the link went; failing ${abandoned.size} calls that will never be answered")
        }
        pending.clear()
        abandoned.forEach {
            it.deadline.cancel()
            it.onOutcome(Outcome.Failed(LINK_LOST))
        }
        sessionRefreshInFlight = false
        sessionRefreshQueued = false
        // The cursor belongs to the link: the next usable link must hear it
        // again, whether it arrives via the link-up hook or the session poll.
        // This is the TRANSPORT-loss half only; [onLinkUp] clears it per
        // handshake, which covers the channels this hook never sees.
        chatCursorReported = false
        // The permitted surface is forgotten with the link so a reconnect re-asks.
        // An allow-list edited on the desktop while the phone was away must not
        // keep a revoked action looking available.
        capabilities.forget()
        // Same reasoning for why the list is empty: a denial belonged to the link
        // that carried it. Held sessions stay — only the explanation is dropped.
        sessions.forget()
    }

    /**
     * The link just became usable. Report the seq of the last chat message this
     * phone holds, so the desktop can replay everything after it — the catch-up
     * that covers both a phone that was out of range and an app restart whose
     * threads are gone. The answer carries nothing this app acts on: the replay
     * arrives afterwards as ordinary `chat` records, deduped by seq in
     * [ChatRepository.receive].
     *
     * Sent FIRST on link up, ahead of the session refresh: the journal replay
     * and the session list are independent, and the cursor is the one request
     * whose answer cannot be re-derived later by a poll.
     *
     * THE FLAG IS CLEARED HERE, not only in [onLinkLost]. The cursor belongs to
     * the HANDSHAKE, not to the transport: this hook fires once per established
     * SecureChannel, whereas the loss hook fires only when the TRANSPORT changes
     * (HelmPairing wires it to `HelmLink.onLinkChanged`). A channel re-made over
     * a transport that never went down — a desktop restart, a re-handshake after
     * a stumble — therefore left the flag standing and the phone never re-asked,
     * which is the reconnect with permanently empty threads. Re-reporting is
     * free: the desktop replays from the same seq and [ChatRepository] dedupes.
     */
    fun onLinkUp(): Boolean {
        chatCursorReported = false
        return reportChatCursorIfNeeded()
    }

    /**
     * Report the cursor if this link has not heard it yet — or has not heard it
     * lately ([CURSOR_REPORT_FRESH_MS]). The flag moves only when the link
     * actually carried the call — and it moves BACK if the call then failed: a
     * report whose answer died with the link was never heard by the desktop, so
     * the next poll must say it again (observed as the empty threads after one
     * reconnect: cursor sent, link dropped before the replay, flag left
     * standing). Staleness reads the same stamp the flag does, so a report
     * known to have failed re-says immediately regardless of the clock.
     */
    private fun reportChatCursorIfNeeded(): Boolean {
        if (chatCursorReported && now() - chatCursorReportedAt < CURSOR_REPORT_FRESH_MS) return true
        val issued = call(METHOD_CHAT_CURSOR, linkedMapOf<String, Any>("seq" to chats.lastSeq())) { outcome ->
            if (outcome is Outcome.Failed) chatCursorReported = false
        }
        chatCursorReported = issued
        if (issued) chatCursorReportedAt = now()
        return issued
    }

    /**
     * Issue one control action and record how it ended, so every outcome is
     * something the user can read. A refusal is told apart from a dead link
     * because they mean opposite things: one is a rule that will hold, the other
     * is a radio that may come back. [onOutcome] sees the same verdict after the
     * notice, for the few actions whose result carries state onward (the spawn's
     * created session, the create's minted artifact).
     */
    private fun act(
        action: SessionAction,
        method: String,
        params: Map<String, Any>,
        onOutcome: (Outcome) -> Unit = {},
    ): Boolean = call(method, params) { outcome ->
        control.noticed(action, outcomeFor(outcome))
        onOutcome(outcome)
    }

    /** One verdict per outcome shape; Refused needs the deny text byte-exact. */
    private fun outcomeFor(outcome: Outcome): ActionOutcome = when {
        outcome is Outcome.Ok -> ActionOutcome.Done
        (outcome as Outcome.Failed).message == MOBILE_DENY_MESSAGE -> ActionOutcome.Refused
        else -> ActionOutcome.Failed(outcome.message)
    }

    /**
     * The `id` a desktop answer carries, read out of its `ok`. Spawn answers
     * `{id: ...}` for the session it started and artifact-create answers the
     * same for the artifact it minted; anything else is null, because navigating
     * to a guessed id is worse than staying put.
     */
    private fun idIn(result: Any?): String? =
        (result as? JSONObject)?.opt("id") as? String

    /** A slot-open answer: `{uploadId, maxSliceBytes, total}`. */
    private fun uploadOffer(result: Any?): UploadOffer? {
        json(result)?.let { json ->
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
        json(result)?.let { json ->
            (json.optJSONObject("attachment")?.opt("id") as? String)
                ?: (json.opt("id") as? String)
        }.orEmpty()

    private fun json(result: Any?): JSONObject? = result as? JSONObject

    /** The offer clipped to what this phone will put in one frame. */
    private fun sliceBudget(advertised: Long): Int =
        minOf(advertised, MAX_UPLOAD_SLICE_BYTES.toLong()).toInt().coerceIn(1, MAX_FRAME_BYTES)

    private fun call(
        method: String,
        params: Map<String, Any>? = null,
        id: String? = null,
        onOutcome: (Outcome) -> Unit,
    ): Boolean {
        val callId = id ?: nextCallId()
        val frame = MobileEnvelope.encodeCall(callId, method, params)
        // Key NAMES only, never values — the same rule the desktop's audit keeps.
        HelmLog.d(HelmLog.CLIENT) {
            "call $id $method, ${frame.size} bytes, args ${params?.keys?.sorted() ?: emptyList<String>()}"
        }
        // Registered only AFTER the link accepts the bytes: a call that was never
        // sent has no answer coming, and leaving it pending would hold a callback
        // — and the message it closes over — until the link drops.
        if (!send(frame)) {
            HelmLog.w(HelmLog.CLIENT, "call $callId $method was not sent; there is no usable link")
            onOutcome(Outcome.Failed(NOT_LINKED))
            return false
        }
        evictOldestIfFull()
        lateinit var deadline: Cancellable
        deadline = scheduler.schedule(REQUEST_DEADLINE_MS) {
            settle(callId, Outcome.Failed(REQUEST_TIMED_OUT))
        }
        pending[callId] = PendingCall(onOutcome, deadline)
        return true
    }

    /** Monotonic call ids — the same "p<n>" the desktop's audit already sees. */
    private fun nextCallId(): String = "p${sequence++}"

    /**
     * The pending map is bounded because nothing else bounds it: Helm answers
     * every call it receives, but a link that dies between send and reply leaves
     * an entry with no arrival to clear it.
     */
    private fun evictOldestIfFull() {
        while (pending.size >= MAX_PENDING) {
            val oldest = pending.keys.first()
            pending.remove(oldest)?.let {
                it.deadline.cancel()
                it.onOutcome(Outcome.Failed(ABANDONED))
            }
        }
    }

    private fun refreshQueuedSessions() {
        if (!sessionRefreshQueued) return
        sessionRefreshQueued = false
        refreshSessions()
    }

    companion object {
        /**
         * The desktop buffer holds this many lines; asking for more spends the
         * link on text that does not exist. The chips on screen 7 sit under it.
         */
        const val MAX_SNAPSHOT_LINES = 500

        /**
         * Every deny path answers with this exact text, by desktop design, so a
         * stolen phone cannot tell a hard-deny from an unknown tool. The app can
         * therefore recognise A refusal, and must never claim to know WHICH.
         */
        const val MOBILE_DENY_MESSAGE = "Tool not permitted"

        private const val METHOD_SESSION_LIST = "session_list"
        private const val METHOD_SESSION_SEND_TEXT = "session_send_text"

        /**
         * The gate's reserved chat-cursor meta-method (see the desktop's
         * `RESERVED_CHAT_CURSOR_METHOD`). In-gate answered, never dispatched —
         * which is also why it needs no allow-list entry.
         */
        private const val METHOD_CHAT_CURSOR = "__chat_cursor__"

        /**
         * How long a reported chat cursor stays believed before the next poll
         * says it again. A journal replay over BLE takes real minutes and can
         * die mid-stream; re-saying after five minutes heals the hole at the
         * next poll instead of the next app restart. Cheap by design: the
         * desktop replays from the same seq and [ChatRepository] dedupes.
         */
        private const val CURSOR_REPORT_FRESH_MS = 5 * 60 * 1000L

        /** The gate's reserved meta-method — answered in-gate, never dispatched. */
        private const val METHOD_MOBILE_TOOLS = "__mobile_tools__"
        private const val METHOD_DIRECTORY_LIST = "directory_list"
        private const val METHOD_READ_TERMINAL = "session_read_terminal"
        private const val METHOD_SESSION_COMPACT = "session_compact"
        private const val METHOD_SESSION_CLOSE = "session_close"
        private const val METHOD_SESSION_RENAME = "session_rename"
        private const val METHOD_SESSION_CREATE = "session_create"

        /** A session's artifacts: list, read, and the writes this app gates per tool. */
        private const val METHOD_SESSION_ARTIFACT_LIST = "session_artifact_list"
        private const val METHOD_SESSION_ARTIFACT_GET = "session_artifact_get"
        private const val METHOD_SESSION_ARTIFACT_CREATE = "session_artifact_create"
        private const val METHOD_SESSION_ARTIFACT_UPDATE = "session_artifact_update"
        private const val METHOD_SESSION_ARTIFACT_DOWNLOAD = "session_artifact_download"
        private const val METHOD_SESSION_ARTIFACT_DELETE = "session_artifact_delete"
        private const val METHOD_SESSION_ARTIFACT_ATTACHMENT_DELETE = "session_artifact_attachment_delete"

        /**
         * The upload half (protocol 4). `add` opens a slot and answers with the
         * slice budget; the slices then travel as raw blob records answered by
         * nothing; `commit` is the one moment the desktop says whether the file
         * exists. There is deliberately no abort — an abandoned slot evicts
         * itself on the desktop, which is one less call to make and one less
         * way to be wrong about a slot that already died.
         */
        private const val METHOD_SESSION_ARTIFACT_ATTACHMENT_ADD = "session_artifact_attachment_add"
        private const val METHOD_SESSION_ARTIFACT_ATTACHMENT_COMMIT = "session_artifact_attachment_commit"

        /** The local ceiling on one upload slice, inside this link's frame cap. */
        private const val MAX_UPLOAD_SLICE_BYTES = 64 * 1024

        /** The secure channel's own frame ceiling, mirrored from crypto/Frames.kt. */
        private const val MAX_FRAME_BYTES = 1024 * 1024

        /** When a staged file never named a type. */
        private const val DEFAULT_MIME = "application/octet-stream"

        /**
         * How often an in-flight slice asks the link how far it has got. Slow
         * enough to cost nothing on a transfer measured in minutes, fast enough
         * that the bar moves rather than steps.
         */
        private const val FLUSH_POLL_MS = 100L

        /** The staged copy vanished before its upload could read it. */
        private const val STAGE_GONE = "The staged file is no longer readable — attach it again"

        /** The staged copy ended before it had given the bytes it declared. */
        private const val STAGE_SHORT = "The staged file changed while it was being sent"

        /** A slot-open answer of a shape this app cannot read. */
        private const val UNREADABLE_UPLOAD_OFFER = "Helm answered with an upload slot this app could not read"

        /**
         * Helm's planning surface, READ side only. No `plan_create`,
         * `plan_set_state` or `plan_complete` constant exists here on purpose:
         * a method name that is never spelled is a call that cannot be made by
         * accident.
         */
        /**
         * The board's list tool is the SUMMARY one, never the full-record
         * `plan_list`: that answers every plan's whole description, which for
         * Helm's own project is a 419 KB reply the 512-byte-chunk link cannot
         * survive. `plan_list` is not spelled anywhere here for the same reason
         * the write methods are not — a name that is never written cannot be
         * called by accident.
         */
        private const val METHOD_PLAN_SUMMARY = "plan_summary"

        /**
         * The only filter this app ever sends. Done plans are noise on a phone
         * and their descriptions are what killed the link in UAT.
         */
        private const val FILTER_ACTIVE = "active"
        private const val METHOD_PLAN_GET = "plan_get"
        private const val METHOD_PLAN_CONTEXT_LIST = "plan_context_list"
        private const val METHOD_SEQUENCE_LIST = "sequence_list"
        private const val METHOD_SEQUENCE_GET = "sequence_get"
        private const val METHOD_CONTEXT_LIST = "context_list"
        private const val METHOD_CONTEXT_GET = "context_get"
        private const val METHOD_PROJECT_LIST = "project_list"

        /** The ONLY kind the session-addressed create accepts; the desktop maps it to 'markdown'. */
        private const val CREATE_KIND = "md"

        /** Same failure, for the download — an unreadable answer is not a file. */
        private const val UNREADABLE_DOWNLOAD = "Helm answered with a file this app could not read"
        private const val NO_FILE_SINK = "This build cannot write files to the device"

        /** Refused client-side, before the link is asked to carry bytes it cannot. */
        private const val TOO_LARGE = "That would not fit the link — trim it, or write it on the desktop"
        /** The full CLI catalogue, for the spawn form. Gated like every dispatch — a read-only tool, so a refusal just falls back to the harvested list. */
        private const val METHOD_TOOL_LIST = "tool_list"

        /** `ok` on the wire carrying a shape the app cannot read, for the fetch the spawn form waits on. */
        private const val UNREADABLE_LIST = "Helm answered with a directory list this app could not read"

        /** Same failure, for the artifacts screen — an unreadable answer is not an empty list. */
        private const val UNREADABLE_ARTIFACTS = "Helm answered with an artifact list this app could not read"
        private const val UNREADABLE_ARTIFACT = "Helm answered with an artifact this app could not read"

        /** Same failure, for each planning surface — an unreadable answer is not an empty one. */
        private const val UNREADABLE_PLANS = "Helm answered with a plan list this app could not read"
        private const val UNREADABLE_PLAN = "Helm answered with a plan this app could not read"
        private const val UNREADABLE_PLAN_CONTEXTS =
            "Helm answered with a plan's context list this app could not read"
        private const val UNREADABLE_SEQUENCES = "Helm answered with a sequence list this app could not read"
        private const val UNREADABLE_SEQUENCE = "Helm answered with a sequence this app could not read"
        private const val UNREADABLE_CONTEXTS = "Helm answered with a context list this app could not read"
        private const val UNREADABLE_CONTEXT = "Helm answered with a context this app could not read"
        private const val UNREADABLE_PROJECTS = "Helm answered with a project list this app could not read"

        /** Cleaned server-side; the phone has no ANSI parser and must not grow one. */
        private const val SNAPSHOT_MODE = "stripped"

        /** Comfortably more than a screen can issue before the first answers. */
        const val MAX_PENDING = 32

        const val NOT_LINKED = "No link to Helm"
        const val LINK_LOST = "The link dropped before Helm answered"
        const val ABANDONED = "Too many calls are waiting for an answer"
        const val REQUEST_TIMED_OUT = "Helm did not answer before the request timed out"
        private const val REQUEST_DEADLINE_MS = 10_000L
    }
}
