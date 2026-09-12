package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** How far an outgoing message got. Null on anything Helm sent us. */
enum class Delivery {
    /** Handed to the link; Helm has not answered the call yet. */
    Sending,

    /** The gate accepted it and the session received the text. */
    Sent,

    /** Denied, rate limited, or the link died mid-call. */
    Failed,
}

/**
 * One line in a session's thread.
 *
 * [key] exists because two messages can share a timestamp and a body — a repeated
 * "done" a millisecond apart is not one message — and Compose needs a stable
 * identity per row that survives reordering.
 */
data class ChatMessage(
    val key: String,
    val text: String,
    val at: Long,
    val fromPhone: Boolean,
    val delivery: Delivery? = null,
    val filePath: String? = null,
    val voice: Boolean = false,
)

/**
 * ChatRepository — the per-session threads behind mockup screen 2.
 *
 * Threads are kept in memory ONLY. A durable phone-side history is a different
 * feature with its own storage and retention questions; what this holds is what
 * has arrived since the app started, which is what the screen shows.
 *
 * Messages are kept in ARRIVAL order, never sorted by `at`: outgoing messages
 * are stamped by the phone clock and incoming ones by the desktop clock, and
 * the two disagree in the wild (an on-device audit caught 65 s of skew), which
 * sorted every phone message into the past. `at` is display data only. A
 * reconnect backlog arrives from Helm in the order it was written, so arrival
 * order reads correctly there too.
 */
class ChatRepository {
    private val _threads = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val threads: StateFlow<Map<String, List<ChatMessage>>> = _threads.asStateFlow()

    private var sequence = 0L

    fun thread(sessionId: String): List<ChatMessage> = _threads.value[sessionId].orEmpty()

    /** A `chat` record from Helm. */
    fun receive(record: MobileRecord.Chat) {
        append(
            record.sessionId,
            ChatMessage(
                key = nextKey(),
                text = record.text,
                at = record.at,
                fromPhone = false,
                filePath = record.filePath,
                voice = record.voice,
            ),
        )
    }

    /**
     * Show what the user just sent, before Helm has confirmed it.
     *
     * Returns the key, so the caller can settle this message when its
     * `session_send_text` call comes back. Optimistic on purpose: a reply that
     * only appears after a BLE round trip reads as a dropped keystroke.
     */
    fun sending(sessionId: String, text: String, at: Long): String {
        val key = nextKey()
        append(sessionId, ChatMessage(key = key, text = text, at = at, fromPhone = true, delivery = Delivery.Sending))
        return key
    }

    /** Settle an outgoing message once its call has been answered — or hasn't. */
    fun settle(sessionId: String, key: String, delivered: Boolean) {
        val thread = _threads.value[sessionId] ?: return
        val settled = thread.map { message ->
            if (message.key == key) {
                message.copy(delivery = if (delivered) Delivery.Sent else Delivery.Failed)
            } else {
                message
            }
        }
        _threads.value = _threads.value + (sessionId to settled)
    }

    private fun append(sessionId: String, message: ChatMessage) {
        val thread = (_threads.value[sessionId].orEmpty() + message).takeLast(MAX_THREAD)
        _threads.value = _threads.value + (sessionId to thread)
    }

    /** Monotonic, so two identical messages in the same millisecond stay distinct. */
    private fun nextKey(): String = "m${sequence++}"

    private companion object {
        /**
         * A phone left running for a week must not accumulate an unbounded thread.
         * Oldest goes first; scrollback beyond this is the desktop's job.
         */
        const val MAX_THREAD = 200
    }
}
