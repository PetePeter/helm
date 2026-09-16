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
 *
 * The threads are the one thing here that does NOT persist. What does is the
 * unread count ([UnreadStore]): a badge that forgets itself on a process death
 * lies in exactly the case it exists for.
 */
class ChatRepository(private var unread: UnreadStore = MemoryUnreadStore()) {
    private val _threads = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val threads: StateFlow<Map<String, List<ChatMessage>>> = _threads.asStateFlow()

    private val _unreadCounts = MutableStateFlow(unread.counts())

    /** Per-session unread counts, as the session list renders them. */
    val unreadCounts: StateFlow<Map<String, Int>> = _unreadCounts.asStateFlow()

    private var sequence = 0L

    /** The session whose thread is on screen, when there is one. */
    private var readingSessionId: String? = null

    fun thread(sessionId: String): List<ChatMessage> = _threads.value[sessionId].orEmpty()

    /**
     * Attach the persistent store and adopt what it remembers — the same late
     * attachment as [com.potatomotato.helm.notify.AlertRouter.useSettings]: the
     * store needs a Context and the client is built before there is one.
     */
    fun useUnreadStore(store: UnreadStore) {
        unread = store
        _unreadCounts.value = store.counts()
    }

    /**
     * Say which thread the user is looking at — and mark it read on the way in:
     * arriving at a thread IS reading it, backlog included. Null when the user
     * is back on the list, so nothing reads as "being read" from there.
     */
    fun reading(sessionId: String?) {
        readingSessionId = sessionId
        if (sessionId != null) markRead(sessionId)
    }

    /** A thread the user has seen stops counting, whatever it got up to. */
    fun markRead(sessionId: String) = setUnread(sessionId, 0)

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
        // Only what arrives unseen counts. The thread the user is reading is
        // being read by definition, and the user's own outgoing words were
        // never news to them — they typed them.
        if (record.sessionId != readingSessionId) {
            setUnread(record.sessionId, (_unreadCounts.value[record.sessionId] ?: 0) + 1)
        }
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

    /** One write, to the flow the screens read and the store the app restarts from. */
    private fun setUnread(sessionId: String, count: Int) {
        val next = _unreadCounts.value.toMutableMap()
        if (count <= 0) next.remove(sessionId) else next[sessionId] = count
        _unreadCounts.value = next
        unread.setCount(sessionId, count)
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
