package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.CapabilityCache
import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.ControlRepository
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionRepository
import com.potatomotato.helm.data.SessionWire
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.notify.AlertRouter
import com.potatomotato.helm.wire.MobileEnvelope
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
    val sessions: SessionRepository = SessionRepository(),
    val chats: ChatRepository = ChatRepository(),
    val capabilities: CapabilityCache = CapabilityCache(),
    val control: ControlRepository = ControlRepository(),
    val alerts: AlertRouter = AlertRouter(),
) {
    /** Outstanding calls, oldest first, each with a deadline that owns its cleanup. */
    private val pending = LinkedHashMap<String, PendingCall>()
    private var sequence = 0L
    private var sessionRefreshInFlight = false
    private var sessionRefreshQueued = false

    private data class PendingCall(
        val onOutcome: (Outcome) -> Unit,
        val deadline: Cancellable,
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
    fun sendChat(sessionId: String, text: String): Boolean {
        val key = chats.sending(sessionId, text, now())
        val params = linkedMapOf("sessionId" to sessionId, "text" to text)
        val issued = call(METHOD_SESSION_SEND_TEXT, params) { outcome ->
            chats.settle(sessionId, key, outcome is Outcome.Ok)
        }
        if (!issued) chats.settle(sessionId, key, delivered = false)
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
        return act(SessionAction.Spawn, METHOD_SESSION_CREATE, params) { outcome ->
            if (outcome is Outcome.Ok) {
                control.spawnCreated(createdSessionId(outcome.result))
                refreshSessions()
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
            is MobileRecord.Failure -> settle(record.id, Outcome.Failed(record.message))
            // THE ONE place a chat record is split. A kind-bearing record is an
            // EVENT Helm is reporting, not something an agent said: routing it
            // into the thread would grow a conversation the desktop never had,
            // and the drift would be invisible from the desktop side.
            is MobileRecord.Chat ->
                if (record.kind == null) chats.receive(record) else alerts.onAlert(record)

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
        // The permitted surface is forgotten with the link so a reconnect re-asks.
        // An allow-list edited on the desktop while the phone was away must not
        // keep a revoked action looking available.
        capabilities.forget()
        // Same reasoning for why the list is empty: a denial belonged to the link
        // that carried it. Held sessions stay — only the explanation is dropped.
        sessions.forget()
    }

    /**
     * Issue one control action and record how it ended, so every outcome is
     * something the user can read. A refusal is told apart from a dead link
     * because they mean opposite things: one is a rule that will hold, the other
     * is a radio that may come back. [onOutcome] sees the same verdict after the
     * notice, for the few actions whose result carries state onward (the spawn's
     * created id).
     */
    private fun act(
        action: SessionAction,
        method: String,
        params: Map<String, Any>,
        onOutcome: (Outcome) -> Unit = {},
    ): Boolean = call(method, params) { outcome ->
        control.noticed(
            action,
            when {
                outcome is Outcome.Ok -> ActionOutcome.Done
                (outcome as Outcome.Failed).message == MOBILE_DENY_MESSAGE -> ActionOutcome.Refused
                else -> ActionOutcome.Failed(outcome.message)
            },
        )
        onOutcome(outcome)
    }

    /**
     * The session a spawn created, read out of its `ok`. The desktop answers
     * `{id: ...}`; anything else is null, because navigating to a guessed id is
     * worse than staying put.
     */
    private fun createdSessionId(result: Any?): String? =
        (result as? JSONObject)?.opt("id") as? String

    private fun call(
        method: String,
        params: Map<String, Any>? = null,
        onOutcome: (Outcome) -> Unit,
    ): Boolean {
        val id = "p${sequence++}"
        val frame = MobileEnvelope.encodeCall(id, method, params)
        // Key NAMES only, never values — the same rule the desktop's audit keeps.
        HelmLog.d(HelmLog.CLIENT) {
            "call $id $method, ${frame.size} bytes, args ${params?.keys?.sorted() ?: emptyList<String>()}"
        }
        // Registered only AFTER the link accepts the bytes: a call that was never
        // sent has no answer coming, and leaving it pending would hold a callback
        // — and the message it closes over — until the link drops.
        if (!send(frame)) {
            HelmLog.w(HelmLog.CLIENT, "call $id $method was not sent; there is no usable link")
            onOutcome(Outcome.Failed(NOT_LINKED))
            return false
        }
        evictOldestIfFull()
        lateinit var deadline: Cancellable
        deadline = scheduler.schedule(REQUEST_DEADLINE_MS) {
            settle(id, Outcome.Failed(REQUEST_TIMED_OUT))
        }
        pending[id] = PendingCall(onOutcome, deadline)
        return true
    }

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

        /** The gate's reserved meta-method — answered in-gate, never dispatched. */
        private const val METHOD_MOBILE_TOOLS = "__mobile_tools__"
        private const val METHOD_DIRECTORY_LIST = "directory_list"
        private const val METHOD_READ_TERMINAL = "session_read_terminal"
        private const val METHOD_SESSION_COMPACT = "session_compact"
        private const val METHOD_SESSION_CLOSE = "session_close"
        private const val METHOD_SESSION_CREATE = "session_create"

        /** The full CLI catalogue, for the spawn form. Gated like every dispatch — a read-only tool, so a refusal just falls back to the harvested list. */
        private const val METHOD_TOOL_LIST = "tool_list"

        /** `ok` on the wire carrying a shape the app cannot read, for the fetch the spawn form waits on. */
        private const val UNREADABLE_LIST = "Helm answered with a directory list this app could not read"

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
