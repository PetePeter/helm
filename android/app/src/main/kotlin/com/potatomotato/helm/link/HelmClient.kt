package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactRepository
import com.potatomotato.helm.data.ArtifactUploads
import com.potatomotato.helm.data.TimeRepository
import com.potatomotato.helm.data.CapabilityCache
import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.ContextRepository
import com.potatomotato.helm.data.ControlRepository
import com.potatomotato.helm.data.PlanRepository
import com.potatomotato.helm.data.PlanWrites
import com.potatomotato.helm.data.SequenceRepository
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionRepository
import com.potatomotato.helm.data.ShareFlow
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.notify.AlertRouter
import com.potatomotato.helm.wire.MobileEnvelope
import com.potatomotato.helm.wire.MobileCallInterruption
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
    internal val send: (ByteArray) -> Boolean,
    internal val now: () -> Long = System::currentTimeMillis,
    internal val scheduler: ChannelScheduler,
    /**
     * Bytes the link has taken but not yet put on the wire — the backpressure
     * an upload paces itself against. See [HelmLink.pendingBytes] for why the
     * link has to be asked rather than inferred from [send]'s return value.
     */
    internal val linkPending: () -> Long = { HelmLink.pendingBytes },
    /**
     * Where a file's slices are pumped. Its own scope, because that pump is the
     * one thing here that BLOCKS: it waits on the radio between slices, and the
     * inbound path it used to run on must never wait for anything.
     */
    internal val uploadScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    sessions: SessionRepository = SessionRepository(),
    chats: ChatRepository = ChatRepository(),
    capabilities: CapabilityCache = CapabilityCache(),
    control: ControlRepository = ControlRepository(),
    artifacts: ArtifactRepository = ArtifactRepository(),
    plans: PlanRepository = PlanRepository(),
    sequences: SequenceRepository = SequenceRepository(),
    planWrites: PlanWrites = PlanWrites(),
    contexts: ContextRepository = ContextRepository(),
    time: TimeRepository = TimeRepository(),
    alerts: AlertRouter = AlertRouter(),
    uploads: ArtifactUploads = ArtifactUploads(),
    shares: ShareFlow = ShareFlow(),
) {
    val sessions = SessionClient(this, sessions, chats, alerts, control)
    val artifacts = ArtifactClient(this, artifacts, uploads, shares, control, chats)
    val plans = PlanClient(this, plans, sequences, planWrites, contexts)
    val workspace = WorkspaceClient(this, capabilities, control, time, contexts)

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
     * The machineId of the desktop the link is up with — whose journal the chat
     * cursor counts (see [ChatRepository]). Read from the pairing state on every
     * use rather than stamped by [onLinkUp], because a relink can come up usable
     * without that hook firing. Settable like [machineId], for the same reason.
     */
    var linkedDesktop: () -> String = { "" }

    /** Outstanding calls, oldest first, with optional deadlines that own their cleanup. */
    private val pending = LinkedHashMap<String, PendingCall>()

    private var sequence = 0L

    private data class PendingCall(
        val onOutcome: (Outcome) -> Unit,
        val deadline: Cancellable?,
    )

    /** How a call ended. A denial and a dead link are both [Failed] — by design. */
    sealed interface Outcome {
        data class Ok(val result: Any?) : Outcome
        data class Failed(val message: String) : Outcome
    }

    /** Everything outstanding fails when the link goes. Nothing waits forever. */
    fun onLinkLost() {
        val abandoned = pending.values.toList()
        if (abandoned.isNotEmpty()) {
            HelmLog.w(HelmLog.CLIENT, "the link went; failing ${abandoned.size} calls that will never be answered")
        }
        pending.clear()
        abandoned.forEach {
            it.deadline?.cancel()
            it.onOutcome(Outcome.Failed(LINK_LOST))
        }
        sessions.onLinkLost()
        // The permitted surface is forgotten with the link so a reconnect re-asks.
        // An allow-list edited on the desktop while the phone was away must not
        // keep a revoked action looking available.
        workspace.capabilities.forget()
        // Same reasoning for why the list is empty: a denial belonged to the link
        // that carried it. Held sessions stay — only the explanation is dropped.
        sessions.state.forget()
    }

    /** A newly usable channel reports the held chat cursor and refreshes sessions. */
    fun onLinkUp(): Boolean = sessions.onLinkUp()

    /** One decrypted application message. Never throws: the link outlives its payloads. */
    fun onInbound(payload: ByteArray) {
        val record = MobileEnvelope.decode(payload)
        if (record == null) {
            HelmLog.w(HelmLog.WIRE, "dropped an inbound record of ${payload.size} bytes: it did not decode")
            return
        }
        HelmLog.d(HelmLog.WIRE) { "inbound ${record.javaClass.simpleName} of ${payload.size} bytes" }
        when (record) {
            is MobileRecord.Result -> settle(record.id, HelmClient.Outcome.Ok(record.result))
            // A download's answer. Correlated and settled exactly like a result —
            // the caller that asked knows it asked for bytes.
            is MobileRecord.Blob -> settle(record.id, HelmClient.Outcome.Ok(record))
            is MobileRecord.Failure -> settle(record.id, HelmClient.Outcome.Failed(record.message))
            // THE ONE place a chat record is split. A kind-bearing record is an
            // EVENT Helm is reporting, not something an agent said: routing it
            // into the thread would grow a conversation the desktop never had,
            // and the drift would be invisible from the desktop side.
            // A kind-less record appears in both the thread and the notification,
            // so the user can see it while elsewhere.
            // A RING is the operator calling: its own surface, never the shade's
            // ordinary row — a buzz you can swipe away is not a phone call.
            is MobileRecord.Chat ->
                when (record.kind) {
                    null -> {
                        sessions.chats.receive(linkedDesktop(), record)
                        sessions.alerts.onMessage(record)
                    }
                    // A delete made elsewhere: the thread's business only, never a buzz.
                    ChatRepository.DELETED_KIND -> sessions.chats.receive(linkedDesktop(), record)
                    HelmClient.RING_KIND -> if (sessions.ringer?.invoke(record) != true) sessions.alerts.onAlert(record)
                    HelmClient.TRANSFER_KIND -> sessions.transferrer?.invoke(record)
                    else -> sessions.alerts.onAlert(record)
                }

            // Where this desktop can be reached over the network. Accepted ONLY
            // here, from the authenticated channel — an address learned any
            // other way is an invitation to dial someone else. An EMPTY list is
            // honoured as "stop dialling", which is how the desktop turning LAN
            // off reaches a phone that is connected right now.
            is MobileRecord.Lan -> onLanAddresses(record.addresses)

            is MobileRecord.Changes -> sessions.onChanges(record)

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
        waiting.deadline?.cancel()
        HelmLog.d(HelmLog.CLIENT) {
            "call $id settled as ${if (outcome is Outcome.Ok) "ok" else "failed"}; ${pending.size} still pending"
        }
        waiting.onOutcome(outcome)
    }

    /**
     * Issue one control action and record how it ended, so every outcome is
     * something the user can read. A refusal is told apart from a dead link
     * because they mean opposite things: one is a rule that will hold, the other
     * is a radio that may come back. [onOutcome] sees the same verdict after the
     * notice, for the few actions whose result carries state onward (the spawn's
     * created session, the create's minted artifact).
     */
    internal fun act(
        control: ControlRepository,
        action: SessionAction,
        method: String,
        params: Map<String, Any>,
        onOutcome: (Outcome) -> Unit = {},
    ): Boolean = call(method, params) { outcome ->
        control.noticed(action, outcomeFor(outcome))
        onOutcome(outcome)
    }

    /** One verdict per outcome shape; Refused needs the deny text byte-exact. */
    internal fun outcomeFor(outcome: Outcome): ActionOutcome = when {
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
    internal fun idIn(result: Any?): String? =
        (result as? JSONObject)?.opt("id") as? String

    internal fun json(result: Any?): JSONObject? = result as? JSONObject

    internal fun call(
        method: String,
        params: Map<String, Any>? = null,
        id: String? = null,
        requestDeadlineMs: Long? = REQUEST_DEADLINE_MS,
        interruption: MobileCallInterruption? = null,
        onOutcome: (Outcome) -> Unit,
    ): Boolean {
        val callId = id ?: nextCallId()
        val frame = MobileEnvelope.encodeCall(callId, method, params, interruption)
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
        val deadline = requestDeadlineMs?.let { timeout ->
            scheduler.schedule(timeout) { settle(callId, Outcome.Failed(REQUEST_TIMED_OUT)) }
        }
        pending[callId] = PendingCall(onOutcome, deadline)
        return true
    }

    /** Monotonic call ids — the same "p<n>" the desktop's audit already sees. */
    internal fun nextCallId(): String = "p${sequence++}"

    /**
     * The pending map is bounded because nothing else bounds it: Helm answers
     * every call it receives, but a link that dies between send and reply leaves
     * an entry with no arrival to clear it.
     */
    private fun evictOldestIfFull() {
        while (pending.size >= MAX_PENDING) {
            val oldest = pending.keys.first()
            pending.remove(oldest)?.let {
                it.deadline?.cancel()
                it.onOutcome(Outcome.Failed(ABANDONED))
            }
        }
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

        internal const val METHOD_SESSION_LIST = "session_list"
        internal const val METHOD_SESSION_SEND_TEXT = "session_send_text"
        internal const val METHOD_SESSION_SET_FROZEN = "session_set_frozen"
        internal const val METHOD_SESSION_SET_KEEP_WARM = "session_set_keep_warm"

        /**
         * The gate's reserved chat-cursor meta-method (see the desktop's
         * `RESERVED_CHAT_CURSOR_METHOD`). In-gate answered, never dispatched —
         * which is also why it needs no allow-list entry.
         */
        internal const val METHOD_CHAT_CURSOR = "__chat_cursor__"

        /** Reserved meta-method: delete journal messages by seq / originId (desktop `RESERVED_CHAT_DELETE_METHOD`). */
        internal const val METHOD_CHAT_DELETE = "__chat_delete__"

        /**
         * How long a reported chat cursor stays believed before the next poll
         * says it again. A journal replay over BLE takes real minutes and can
         * die mid-stream; re-saying after five minutes heals the hole at the
         * next poll instead of the next app restart. Cheap by design: the
         * desktop replays from the same seq and [ChatRepository] dedupes.
         */
        internal const val CURSOR_REPORT_FRESH_MS = 5 * 60 * 1000L

        /** The gate's reserved meta-method — answered in-gate, never dispatched. */
        internal const val METHOD_MOBILE_TOOLS = "__mobile_tools__"
        internal const val METHOD_RESTART_HELM = "__restart_helm__"
        internal const val METHOD_RING_ANSWERED = "__ring_answered__"
        internal const val METHOD_TIMESHEET = "__timesheet__"
        /** The `changes` record kind for the session list; `SESSIONS_CHANGE_KIND` on the desktop. */
        internal const val SESSIONS_CHANGE_KIND = "sessions"
        internal const val RING_KIND = "ring"
        internal const val TRANSFER_KIND = "transfer"
        internal const val METHOD_DIRECTORY_LIST = "directory_list"
        internal const val METHOD_PEER_LIST = "peer_list"
        internal const val METHOD_PEER_CALL = "peer_call"
        internal const val METHOD_PEER_SPAWN = "peer_spawn"
        internal const val METHOD_READ_TERMINAL = "session_read_terminal"
        internal const val METHOD_SESSION_COMPACT = "session_compact"
        internal const val METHOD_SESSION_CLEAR = "session_clear"
        internal const val METHOD_SESSION_QUICK_COMPACT = "session_quick_compact"
        internal const val METHOD_SESSION_SWITCH_CLI = "session_switch_cli"
        internal const val METHOD_SESSION_CLONE = "session_clone"
        internal const val METHOD_SESSION_SEND_INPUT = "session_send_input"
        internal const val METHOD_SESSION_CLOSE = "session_close"
        internal const val METHOD_SESSION_RENAME = "session_rename"
        internal const val METHOD_SESSION_CREATE = "session_create"

        /** A session's artifacts: list, read, and the writes this app gates per tool. */
        internal const val METHOD_SESSION_ARTIFACT_LIST = "session_artifact_list"
        internal const val METHOD_SESSION_ARTIFACT_GET = "session_artifact_get"
        internal const val METHOD_SESSION_ARTIFACT_CREATE = "session_artifact_create"
        internal const val METHOD_SESSION_ARTIFACT_UPDATE = "session_artifact_update"
        internal const val METHOD_SESSION_ARTIFACT_SET_INTENT = "session_artifact_set_intent"
        internal const val METHOD_SESSION_ARTIFACT_DOWNLOAD = "session_artifact_download"
        internal const val METHOD_SESSION_ARTIFACT_DELETE = "session_artifact_delete"
        internal const val METHOD_SESSION_ARTIFACT_ATTACHMENT_DELETE = "session_artifact_attachment_delete"

        /**
         * The upload half (protocol 4). `add` opens a slot; raw slices fill it;
         * `commit` reports success. Share uploads also have an explicit cancel
         * so the phone can stop the transfer and release an unfinished slot.
         */
        internal const val METHOD_SESSION_ARTIFACT_ATTACHMENT_ADD = "session_artifact_attachment_add"
        internal const val METHOD_SESSION_ARTIFACT_ATTACHMENT_COMMIT = "session_artifact_attachment_commit"

        /** Share-to-Helm: the same slot protocol, sent to a session's CLI as a prompt. */
        internal const val METHOD_SESSION_SHARE_FILE_ADD = "session_share_file_add"
        internal const val METHOD_SESSION_SHARE_FILE_COMMIT = "session_share_file_commit"
        internal const val METHOD_SESSION_SHARE_FILE_CANCEL = "session_share_file_cancel"

        /** The local ceiling on one upload slice, inside this link's frame cap. */
        internal const val MAX_UPLOAD_SLICE_BYTES = 64 * 1024

        /** The secure channel's own frame ceiling, mirrored from crypto/Frames.kt. */
        internal const val MAX_FRAME_BYTES = 1024 * 1024

        /** When a staged file never named a type. */
        internal const val DEFAULT_MIME = "application/octet-stream"

        /**
         * How often an in-flight slice asks the link how far it has got. Slow
         * enough to cost nothing on a transfer measured in minutes, fast enough
         * that the bar moves rather than steps.
         */
        internal const val FLUSH_POLL_MS = 100L

        /** Ask whether to keep waiting once the upload has run for a minute. */
        internal const val SHARE_WAIT_PROMPT_MS = 60_000L

        /** The staged copy vanished before its upload could read it. */
        internal const val STAGE_GONE = "The staged file is no longer readable — attach it again"

        /** The staged copy ended before it had given the bytes it declared. */
        internal const val STAGE_SHORT = "The staged file changed while it was being sent"

        /** A slot-open answer of a shape this app cannot read. */
        internal const val UNREADABLE_UPLOAD_OFFER = "Helm answered with an upload slot this app could not read"
        internal const val SHARE_FAILED = "The file share failed"

        /**
         * Helm's planning surface: reads and, since P-0812, single-record writes
         * plus directory cleanup. What is STILL never spelled is any tool that
         * answers every plan's full record (see below).
         */
        /**
         * The board's list tool is the SUMMARY one, never the full-record
         * `plan_list`: that answers every plan's whole description, which for
         * Helm's own project is a 419 KB reply the 512-byte-chunk link cannot
         * survive. `plan_list` is not spelled anywhere here for the same reason
         * the write methods are not — a name that is never written cannot be
         * called by accident.
         */
        internal const val METHOD_PLAN_SUMMARY = "plan_summary"

        /**
         * The only filter this app ever sends. Done plans are noise on a phone
         * and their descriptions are what killed the link in UAT.
         */
        internal const val FILTER_ACTIVE = "active"
        internal const val METHOD_PLAN_GET = "plan_get"
        internal const val METHOD_PLAN_CONTEXT_LIST = "plan_context_list"
        internal const val METHOD_SEQUENCE_LIST = "sequence_list"
        internal const val METHOD_SEQUENCE_GET = "sequence_get"
        internal const val METHOD_PLAN_CREATE = "plan_create"
        internal const val METHOD_PLAN_UPDATE = "plan_update"
        internal const val METHOD_PLAN_SET_STATE = "plan_set_state"
        internal const val METHOD_PLAN_ACCEPT_SUGGESTION = "plan_accept_suggestion"
        internal const val METHOD_PLAN_REJECT_SUGGESTION = "plan_reject_suggestion"
        internal const val METHOD_PLAN_COMPLETE = "plan_complete"
        internal const val METHOD_PLAN_REOPEN = "plan_reopen"
        internal const val METHOD_PLAN_DELETE = "plan_delete"
        internal const val METHOD_SEQUENCE_ASSIGN = "sequence_assign"
        internal const val METHOD_SEQUENCE_CREATE = "sequence_create"
        internal const val METHOD_SEQUENCE_UPDATE = "sequence_update"
        internal const val METHOD_SEQUENCE_DELETE = "sequence_delete"
        internal const val METHOD_PLAN_CLEANUP_COUNTS = "plan_cleanup_counts"
        internal const val METHOD_SEQUENCE_CLEAR_EMPTY = "sequence_clear_empty"
        internal const val METHOD_CONTEXT_CLEAR_UNREFERENCED = "context_clear_unreferenced"
        internal const val UNREADABLE_CLEANUP = "Helm answered with cleanup counts this app could not read"
        internal const val METHOD_CONTEXT_LIST = "context_list"
        internal const val METHOD_CONTEXT_GET = "context_get"
        internal const val METHOD_PROJECT_LIST = "project_list"

        /** The ONLY kind the session-addressed create accepts; the desktop maps it to 'markdown'. */
        internal const val CREATE_KIND = "md"

        /** Same failure, for the download — an unreadable answer is not a file. */
        internal const val UNREADABLE_DOWNLOAD = "Helm answered with a file this app could not read"
        internal const val NO_FILE_SINK = "This build cannot write files to the device"

        /** Refused client-side, before the link is asked to carry bytes it cannot. */
        internal const val TOO_LARGE = "That would not fit the link — trim it, or write it on the desktop"
        /** The full CLI catalogue, for the spawn form. Gated like every dispatch — a read-only tool, so a refusal just falls back to the harvested list. */
        internal const val METHOD_TOOL_LIST = "tool_list"

        /** `ok` on the wire carrying a shape the app cannot read, for the fetch the spawn form waits on. */
        internal const val UNREADABLE_LIST = "Helm answered with a directory list this app could not read"

        /** Same failure, for the artifacts screen — an unreadable answer is not an empty list. */
        internal const val UNREADABLE_ARTIFACTS = "Helm answered with an artifact list this app could not read"
        internal const val UNREADABLE_ARTIFACT = "Helm answered with an artifact this app could not read"

        /** Same failure, for each planning surface — an unreadable answer is not an empty one. */
        internal const val UNREADABLE_PLANS = "Helm answered with a plan list this app could not read"
        internal const val UNREADABLE_PLAN = "Helm answered with a plan this app could not read"
        internal const val UNREADABLE_PLAN_CONTEXTS =
            "Helm answered with a plan's context list this app could not read"
        internal const val UNREADABLE_SEQUENCES = "Helm answered with a sequence list this app could not read"
        internal const val UNREADABLE_SEQUENCE = "Helm answered with a sequence this app could not read"
        internal const val UNREADABLE_TIME = "Helm answered with a timesheet this app could not read"
        internal const val UNREADABLE_CONTEXTS = "Helm answered with a context list this app could not read"
        internal const val UNREADABLE_CONTEXT = "Helm answered with a context this app could not read"
        internal const val UNREADABLE_PROJECTS = "Helm answered with a project list this app could not read"

        /** Cleaned server-side; the phone has no ANSI parser and must not grow one. */
        internal const val SNAPSHOT_MODE = "screen"
        internal const val LEGACY_SNAPSHOT_MODE = "stripped"
        internal const val LEGACY_SCREEN_MODE_ERROR = "mode must be one of raw, stripped, or both"
        internal const val PROPOSED_SCREEN_API_ERROR =
            "You must set the allowProposedApi option to true to use proposed API"

        /** Comfortably more than a screen can issue before the first answers. */
        const val MAX_PENDING = 32

        const val NOT_LINKED = "No link to Helm"
        const val LINK_LOST = "The link dropped before Helm answered"
        const val ABANDONED = "Too many calls are waiting for an answer"
        const val REQUEST_TIMED_OUT = "Helm did not answer before the request timed out"
        internal const val REQUEST_DEADLINE_MS = 10_000L
    }
}
