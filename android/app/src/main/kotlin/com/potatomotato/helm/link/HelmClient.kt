package com.potatomotato.helm.link

import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.SessionRepository
import com.potatomotato.helm.data.SessionWire
import com.potatomotato.helm.wire.MobileEnvelope
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
    val sessions: SessionRepository = SessionRepository(),
    val chats: ChatRepository = ChatRepository(),
) {
    /** Outstanding calls, oldest first. */
    private val pending = LinkedHashMap<String, (Outcome) -> Unit>()
    private var sequence = 0L

    /** How a call ended. A denial and a dead link are both [Failed] — by design. */
    sealed interface Outcome {
        data class Ok(val result: Any?) : Outcome
        data class Failed(val message: String) : Outcome
    }

    /** Ask for the session list. False when the link cannot carry the request. */
    fun refreshSessions(): Boolean = call(METHOD_SESSION_LIST) { outcome ->
        // A failed refresh leaves the previous snapshot alone: a stale list is
        // far more useful than an empty one, and the link state in the app bar
        // already tells the user why nothing is moving.
        if (outcome is Outcome.Ok) SessionWire.parseList(outcome.result)?.let(sessions::applySnapshot)
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

    /** One decrypted application message. Never throws: the link outlives its payloads. */
    fun onInbound(payload: ByteArray) {
        when (val record = MobileEnvelope.decode(payload)) {
            is MobileRecord.Result -> pending.remove(record.id)?.invoke(Outcome.Ok(record.result))
            is MobileRecord.Failure -> pending.remove(record.id)?.invoke(Outcome.Failed(record.message))
            is MobileRecord.Chat -> chats.receive(record)

            // A `call` inbound is Helm asking the PHONE to do something, which it
            // never does — the phone has no gate of its own to answer through.
            // An unrecognised id is an answer to a call already abandoned. Both
            // are dropped in silence; neither is a reason to disturb the user.
            is MobileRecord.Call, null -> Unit
        }
    }

    /** Everything outstanding fails when the link goes. Nothing waits forever. */
    fun onLinkLost() {
        val abandoned = pending.values.toList()
        pending.clear()
        abandoned.forEach { it(Outcome.Failed(LINK_LOST)) }
    }

    private fun call(
        method: String,
        params: Map<String, String>? = null,
        onOutcome: (Outcome) -> Unit,
    ): Boolean {
        val id = "p${sequence++}"
        // Registered only AFTER the link accepts the bytes: a call that was never
        // sent has no answer coming, and leaving it pending would hold a callback
        // — and the message it closes over — until the link drops.
        if (!send(MobileEnvelope.encodeCall(id, method, params))) {
            onOutcome(Outcome.Failed(NOT_LINKED))
            return false
        }
        evictOldestIfFull()
        pending[id] = onOutcome
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
            pending.remove(oldest)?.invoke(Outcome.Failed(ABANDONED))
        }
    }

    private companion object {
        const val METHOD_SESSION_LIST = "session_list"
        const val METHOD_SESSION_SEND_TEXT = "session_send_text"

        /** Comfortably more than a screen can issue before the first answers. */
        const val MAX_PENDING = 32

        const val NOT_LINKED = "No link to Helm"
        const val LINK_LOST = "The link dropped before Helm answered"
        const val ABANDONED = "Too many calls are waiting for an answer"
    }
}
