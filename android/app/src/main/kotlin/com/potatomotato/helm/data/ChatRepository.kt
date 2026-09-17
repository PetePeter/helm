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
    /** A file Helm is offering. Null on an ordinary message. */
    val attachment: ChatAttachment? = null,
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
                attachment = attachmentIn(record),
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

    /**
     * Take one message back out of the thread — the long-press delete. Arrival
     * order of everything left is untouched: a removal is not a reordering.
     * An unknown key or an absent thread is a no-op, and a no-op must not
     * invent the thread it was asked about.
     */
    fun remove(sessionId: String, key: String) {
        val thread = _threads.value[sessionId] ?: return
        _threads.value = _threads.value + (sessionId to thread.filterNot { it.key == key })
    }

    /**
     * Send the text again — the retry button on a FAILED message. The dead
     * attempt is removed and a fresh optimistic one takes its place at the
     * tail, because the retry is a new arrival, not a resurrection of the old
     * one. Returns the new key for the caller to settle; null when there is
     * nothing failed to retry.
     */
    fun retry(sessionId: String, key: String, at: Long): String? {
        val failed = _threads.value[sessionId]?.find { it.key == key } ?: return null
        if (failed.delivery != Delivery.Failed) return null
        remove(sessionId, key)
        return sending(sessionId, failed.text, at)
    }

    // -------------------------------------------------------------------------
    // Attachment pulls
    //
    // Kept HERE rather than in the screen because a fetch outruns its composable:
    // scrolling a tile off screen, or leaving the thread and coming back, must
    // not restart a transfer that is halfway across a BLE link.
    // -------------------------------------------------------------------------

    private val _pulls = MutableStateFlow<Map<String, PullState>>(emptyMap())

    /** Per-message fetch state, keyed by [ChatMessage.key]. */
    val pulls: StateFlow<Map<String, PullState>> = _pulls.asStateFlow()

    private val transfers = mutableMapOf<String, AttachmentTransfer>()

    fun pullState(key: String): PullState = _pulls.value[key] ?: PullState.Idle

    /**
     * Begin (or resume) a fetch. Returns the offset to ask from — which is not
     * always zero: a retry after a stumble resumes from what already arrived.
     * Returns null when a fetch is already running, so a double tap on the tile
     * cannot start two loops writing into one buffer.
     */
    fun pullStarted(key: String, attachment: ChatAttachment): Long? {
        if (_pulls.value[key] is PullState.Pulling) return null
        val transfer = transfers.getOrPut(key) { AttachmentTransfer(attachment.sizeBytes) }
        setPull(key, transfer.state())
        return transfer.nextOffset()
    }

    /**
     * Take one slice. Returns the complete file when that slice was the last
     * one, and null while there is more to come — so the caller has exactly one
     * signal for "now save it". A slice that does not fit where we are is
     * reported as a failure rather than quietly dropped: silently ignoring it
     * would leave the loop asking for the same offset forever.
     */
    fun sliceArrived(key: String, offset: Long, bytes: ByteArray, eof: Boolean): ByteArray? {
        val transfer = transfers[key] ?: return null
        if (!transfer.accept(offset, bytes, eof)) {
            pullFailed(key, OUT_OF_ORDER)
            return null
        }
        if (!transfer.done) {
            setPull(key, transfer.state())
            return null
        }
        return transfer.bytes()
    }

    /** Where the next slice must start, or null when nothing is in flight. */
    fun pullOffset(key: String): Long? = transfers[key]?.nextOffset()

    /**
     * The fetch stumbled. What arrived is KEPT: a retry resumes from there,
     * which on a slow link is the difference between a lost minute and a lost
     * transfer.
     */
    fun pullFailed(key: String, message: String) {
        setPull(key, PullState.Failed(message))
    }

    /** The bytes reached the device. The tile becomes an open button. */
    fun pullSaved(key: String, uri: String) {
        transfers.remove(key)
        setPull(key, PullState.Ready(uri))
    }

    /** Abandon a fetch and its part-file. Nothing half-written is kept. */
    fun pullCancelled(key: String) {
        transfers.remove(key)
        setPull(key, PullState.Idle)
    }

    private fun setPull(key: String, state: PullState) {
        _pulls.value = if (state is PullState.Idle) _pulls.value - key else _pulls.value + (key to state)
    }

    /** The attachment keys travel flat on the wire; they are one thing here. */
    private fun attachmentIn(record: MobileRecord.Chat): ChatAttachment? {
        val artifactId = record.artifactId ?: return null
        val attachmentId = record.attachmentId ?: return null
        return ChatAttachment(
            artifactId = artifactId,
            attachmentId = attachmentId,
            // A record missing a name or a type is still fetchable; only the
            // ids are load-bearing, so the rest falls back rather than
            // discarding a file the desktop meant to send.
            filename = record.filename ?: attachmentId,
            mimeType = record.mimeType ?: "application/octet-stream",
            sizeBytes = record.sizeBytes ?: 0L,
        )
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

        /** A slice that did not fit where the transfer was. See [sliceArrived]. */
        const val OUT_OF_ORDER = "The file arrived out of order"
    }
}
