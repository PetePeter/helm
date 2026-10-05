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

    /** Refused because the session is frozen — thaw it, then send again. */
    Frozen,
}

/** The desktop's refusal for a frozen session (src/session/frozen.ts) — matched by its wording. */
fun isFrozenRefusal(message: String): Boolean = "is frozen" in message

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
    /**
     * The desktop journal number this row arrived under. Null on rows that
     * never carried one — this phone's own optimistic sends, and records from
     * an old desktop build. Not display data: it is the key a replayed
     * gap-fill dedupes against (see [receive]).
     */
    val seq: Long? = null,
    /**
     * This phone's OWN sent message: the originId the desktop journaled it
     * under ("machineId:callId"). Its optimistic row never learns a seq — the
     * journal echo is dropped as this phone's own words — so this is the only
     * name the desktop knows the row by when the user deletes it.
     */
    val originId: String? = null,
    /** Reply stats (see [MobileRecord.Chat.contextTokens]); null where the desktop knew none. */
    val contextTokens: Long? = null,
    val toolCalls: Int? = null,
    val contextWindow: Long? = null,
    val thoughtCount: Int? = null,
)

/**
 * The muted badge under a reply: "ctx 12.3k · 5% · 4 tools". Null when the row
 * carries no stats. Thousands get one decimal; the percent full appears only
 * when the window is known; zero thought and tool counts are omitted.
 */
fun replyStats(contextTokens: Long?, toolCalls: Int?, contextWindow: Long? = null, thoughtCount: Int? = null): String? {
    if (contextTokens == null && toolCalls == null && thoughtCount == null) return null
    val parts = mutableListOf<String>()
    if (contextTokens != null) {
        parts += if (contextTokens >= 1000) {
            "ctx " + String.format(java.util.Locale.ROOT, "%.1fk", contextTokens / 1000.0)
        } else {
            "ctx $contextTokens"
        }
        if (contextWindow != null && contextWindow > 0) {
            parts += "${Math.round(contextTokens * 100.0 / contextWindow)}%"
        }
    }
    if (thoughtCount != null && thoughtCount > 0) parts += if (thoughtCount == 1) "1 thought" else "$thoughtCount thoughts"
    if (toolCalls != null && toolCalls > 0) parts += if (toolCalls == 1) "1 tool" else "$toolCalls tools"
    return parts.joinToString(" · ").ifEmpty { null }
}

/**
 * One deleted row as the desktop can find it: by journal [seq] when the row
 * came from the desktop, by [originId] when it is this phone's own send.
 * Exactly one of the two is set.
 */
data class ChatDeleteItem(val seq: Long? = null, val originId: String? = null)

/**
 * ChatRepository — the per-session threads behind mockup screen 2.
 *
 * Threads persist through a [ChatStore], capped at [MAX_THREAD] rows each, so
 * a reopened app shows its chats at once instead of an empty screen waiting on
 * the replay.
 *
 * Messages are kept in ARRIVAL order, never sorted by `at`: outgoing messages
 * are stamped by the phone clock and incoming ones by the desktop clock, and
 * the two disagree in the wild (an on-device audit caught 65 s of skew), which
 * sorted every phone message into the past. `at` is display data only. A
 * reconnect backlog arrives from Helm in the order it was written, so arrival
 * order reads correctly there too.
 *
 * ONE exception: a replayed gap (see [receive]) files in SEQ order. A live
 * record can outrun the replay it belongs to — the cursor jumps the gap, the
 * replayed hole then lands below the cursor — and pure arrival order would
 * leave the conversation reading with exactly the hole the replay exists to
 * close.
 *
 * The catch-up cursor is PER DESKTOP, keyed by its machineId: each desktop's
 * journal numbers its own seq from 1, so one shared cursor let a busy desktop's
 * high number swallow a quieter desktop's live records as "duplicates". Threads
 * need no such key — session ids are already unique across desktops.
 *
 * The cursors persist TOGETHER with the threads, as one snapshot. A
 * cursor saved on its own would describe history the restarted process no
 * longer holds, and the link-up report of it would talk Helm out of the very
 * replay the restart needs. Saved with its threads, it only ever claims what
 * the restart gets back — so Helm replays just the gap. No snapshot (a fresh
 * install, wiped data, an unreadable file) reports zero and refetches the
 * whole 24h journal.
 *
 * Mutators are @Synchronized: records arrive on the link's collector while
 * sends and edits come from the UI thread, and each change is a
 * read-modify-write of the threads plus a snapshot of them for the store.
 */
class ChatRepository(
    private var unread: UnreadStore = MemoryUnreadStore(),
    private var store: ChatStore = MemoryChatStore(),
) {
    private val _threads = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val threads: StateFlow<Map<String, List<ChatMessage>>> = _threads.asStateFlow()

    private val _unreadCounts = MutableStateFlow(unread.counts())

    /** Per-session unread counts, as the session list renders them. */
    val unreadCounts: StateFlow<Map<String, Int>> = _unreadCounts.asStateFlow()

    private var sequence = 0L

    /** The catch-up cursors: the highest seq held per desktop, saved only beside its threads. */
    private var cursors: Map<String, Long> = emptyMap()

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
     * Attach the persistent chat store and adopt its snapshot — late, like
     * [useUnreadStore], and before the link comes up so the link-up report
     * already carries the saved cursor. A repository that has already received
     * something keeps what it holds rather than mixing two histories.
     */
    @Synchronized
    fun useChatStore(chatStore: ChatStore) {
        store = chatStore
        if (cursors.isNotEmpty() || _threads.value.isNotEmpty()) return
        val saved = chatStore.load() ?: return
        cursors = saved.cursors
        saved.sentIds.forEach { sentIds[it] = Unit }
        _threads.value = saved.threads.mapValues { (_, thread) ->
            thread.takeLast(MAX_THREAD).map { row ->
                // A send that never settled before the process died never will.
                val delivery = if (row.delivery == Delivery.Sending) Delivery.Failed else row.delivery
                row.copy(key = nextKey(), delivery = delivery)
            }
        }
    }

    /**
     * Drop the threads of sessions the desktop no longer lists — called on every
     * session-list sync, so the saved file cannot collect the dead.
     */
    @Synchronized
    fun retainSessions(liveIds: Set<String>, now: Long = System.currentTimeMillis()) {
        // A thread goes only when it is unlisted AND idle past the journal
        // window. One short list (a desktop mid-restart, a partial answer) must
        // not erase history: the cursor stays high, so nothing would refill it.
        val keep = _threads.value.filter { (id, thread) ->
            id in liveIds || (thread.lastOrNull()?.at ?: 0L) > now - JOURNAL_WINDOW_MS
        }
        if (keep.size == _threads.value.size) return
        setThreads(keep)
    }

    /**
     * The seq of the last chat message held — what the desktop replays after.
     * Survives a restart with the threads it counts; see the class doc.
     */
    fun lastSeq(desktopId: String): Long = cursors[desktopId] ?: 0L

    /**
     * Record that a call carrying this phone's own words was SENT, so the echoed
     * journal copy the desktop replays later can be recognised and dropped. The
     * id is the call id the desktop journaled, prefixed with this phone's
     * machineId — see [MobileRecord.Chat.originId].
     *
     * Bounded like every other unbounded-here structure: a phone left running
     * for a week must not grow a set that never shrinks. The oldest id falls out
     * first, which is safe — an echo older than the set predates every message
     * the cursor would replay anyway.
     */
    @Synchronized
    fun sent(originId: String, sessionId: String? = null, key: String? = null) {
        sentIds[originId] = Unit
        while (sentIds.size > MAX_SENT_IDS) sentIds.remove(sentIds.keys.first())
        // Tag the optimistic row too: it is how a later delete names it.
        val thread = sessionId?.let { _threads.value[it] }
        if (thread != null && key != null) {
            setThreads(_threads.value + (sessionId to thread.map { if (it.key == key) it.copy(originId = originId) else it }))
        } else {
            persist()
        }
    }

    private val sentIds = linkedMapOf<String, Unit>()

    /**
     * Say which thread the user is looking at — and mark it read on the way in:
     * arriving at a thread IS reading it, backlog included. Null when the user
     * is back on the list, so nothing reads as "being read" from there.
     */
    @Synchronized
    fun reading(sessionId: String?) {
        readingSessionId = sessionId
        if (sessionId != null) markRead(sessionId)
    }

    /** A thread the user has seen stops counting, whatever it got up to. */
    @Synchronized
    fun markRead(sessionId: String) = setUnread(sessionId, 0)

    /**
     * A `chat` record from Helm.
     *
     * Two sends share the wire and seq is the only order they agree on: the
     * live fan-out, and the journal replay. The race this survives — a live
     * record with a higher seq can cross while this phone's cursor request is
     * still in flight, the cursor jumps OVER the gap, and the replayed gap then
     * arrives at or below the cursor. Dropping it there loses the hole until
     * the app restarts, so a record flagged `replay` below the cursor is
     * FILLED into its thread instead — deduped by seq, cursor untouched.
     *
     * [desktopId] is the machineId of the desktop the record came from — the
     * cursor it counts against.
     */
    @Synchronized
    fun receive(desktopId: String, record: MobileRecord.Chat) {
        if (record.kind == DELETED_KIND) return receiveTombstone(desktopId, record)
        val seq = record.seq
        if (seq != null && seq <= lastSeq(desktopId)) {
            // A LIVE record at or below the cursor can only be a duplicate of
            // something already held: the desktop numbers forward, so live
            // fan-out never re-sends old news unflagged. Only a flagged replay
            // is a gap to fill — and only if the thread does not hold it.
            if (!record.replay) return
            if (holds(record.sessionId, seq)) return
            if (isOwnEcho(record)) return
            insertBySeq(record)
            countUnread(record)
            return
        }
        // THE CURSOR ADVANCES BEFORE ANYTHING ELSE, and it is also the dedupe
        // for the live path: a record the desktop replays after a link stumble
        // can race its own live copy here, and seq is the only order the two
        // sends share. A record WITHOUT a seq — an old desktop build, an alert
        // — updates nothing, so catch-up degrades to today's live-only
        // behaviour rather than to a cursor that claims history it never held.
        if (seq != null) cursors = cursors + (desktopId to seq)
        // This phone's OWN words, echoed back from the journal. Dropped AFTER the
        // cursor advanced: the message is history this phone holds either way,
        // and a cursor that refused it would ask for it again on every link up.
        // The optimistic copy the user watched leave is still on screen — one
        // row, as typed, not two.
        // The cursor is saved WITH the row it counts (append persists), never
        // ahead of it — a cursor-only snapshot on disk would skip that row.
        // A row the thread already holds is the same kind of history: a cursor
        // that was forgotten (a snapshot migration) replays what is on screen.
        if (isOwnEcho(record) || (seq != null && holds(record.sessionId, seq))) {
            persist()
            return
        }
        append(record.sessionId, message(record))
        countUnread(record)
    }

    /**
     * A delete made elsewhere (another phone, the desktop). The tombstone is a
     * journaled message in its own right, so it moves the cursor like one — a
     * live duplicate at or below it is dropped, a flagged replay still applies
     * (the delete is idempotent). It is never shown and never counts as unread.
     */
    private fun receiveTombstone(desktopId: String, record: MobileRecord.Chat) {
        val seq = record.seq
        if (seq != null && seq <= lastSeq(desktopId) && !record.replay) return
        if (seq != null && seq > lastSeq(desktopId)) cursors = cursors + (desktopId to seq)
        val target = record.deletes
        val thread = _threads.value[record.sessionId]
        if (target == null || thread == null || thread.none { it.seq == target }) {
            persist()
            return
        }
        setThreads(_threads.value + (record.sessionId to thread.filterNot { it.seq == target }))
    }

    /** Whether the thread already holds a row under this journal number. */
    private fun holds(sessionId: String, seq: Long): Boolean =
        _threads.value[sessionId]?.any { it.seq == seq } == true

    /** This phone's own words, echoed back from the journal. */
    private fun isOwnEcho(record: MobileRecord.Chat): Boolean =
        record.originId != null && sentIds.containsKey(record.originId)

    /**
     * File a replayed gap into its thread IN SEQ ORDER, ahead of the numbered
     * rows that raced it here. Rows without a seq are not anchors — they keep
     * the arrival spot they earned; the gap goes ahead of the first numbered
     * row newer than it, or the tail when there is none. Capped like every
     * append: a gap older than the window is the desktop's history to hold,
     * not this thread's.
     */
    private fun insertBySeq(record: MobileRecord.Chat) {
        val seq = record.seq ?: return
        val thread = _threads.value[record.sessionId].orEmpty()
        val at = thread.indexOfFirst { it.seq != null && it.seq > seq }
        val next = if (at < 0) thread + message(record)
        else thread.subList(0, at) + message(record) + thread.subList(at, thread.size)
        setThreads(_threads.value + (record.sessionId to next.takeLast(MAX_THREAD)))
    }

    /** The row a journal record becomes, seq riding along as the dedupe key. */
    private fun message(record: MobileRecord.Chat) = ChatMessage(
        key = nextKey(),
        text = record.text,
        at = record.at,
        // An originId names a phone, so it can only be a phone's words —
        // never an agent's. Rendering it as an agent bubble would
        // fabricate a speaker the desktop never had.
        fromPhone = record.originId != null,
        filePath = record.filePath,
        voice = record.voice,
        attachment = attachmentIn(record),
        seq = record.seq,
        contextTokens = record.contextTokens,
        toolCalls = record.toolCalls,
        contextWindow = record.contextWindow,
        thoughtCount = record.thoughtCount,
    )

    /**
     * Only what arrives unseen counts. The thread the user is reading is
     * being read by definition, and the user's own outgoing words were
     * never news to them — they typed them.
     */
    private fun countUnread(record: MobileRecord.Chat) {
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
    @Synchronized
    fun sending(sessionId: String, text: String, at: Long): String {
        val key = nextKey()
        append(sessionId, ChatMessage(key = key, text = text, at = at, fromPhone = true, delivery = Delivery.Sending))
        return key
    }

    /** Settle an outgoing message once its call has been answered — or hasn't. */
    @Synchronized
    fun settle(sessionId: String, key: String, delivered: Boolean, frozen: Boolean = false) {
        val thread = _threads.value[sessionId] ?: return
        val settled = thread.map { message ->
            if (message.key == key) {
                message.copy(delivery = when {
                    delivered -> Delivery.Sent
                    frozen -> Delivery.Frozen
                    else -> Delivery.Failed
                })
            } else {
                message
            }
        }
        setThreads(_threads.value + (sessionId to settled))
    }

    /**
     * Take one message back out of the thread — the long-press delete. Arrival
     * order of everything left is untouched: a removal is not a reordering.
     * An unknown key or an absent thread is a no-op, and a no-op must not
     * invent the thread it was asked about.
     */
    @Synchronized
    fun remove(sessionId: String, key: String) {
        val thread = _threads.value[sessionId] ?: return
        setThreads(_threads.value + (sessionId to thread.filterNot { it.key == key }))
    }

    /**
     * Delete several rows at once — the selection bar's Delete. Returns how the
     * desktop can name each removed row so it can delete its copy too (and, for
     * an API-tool session, the turn from the model's history). A row with
     * neither a seq nor an originId never reached the desktop's journal — a
     * send that failed — so it is removed here and named to nobody.
     */
    @Synchronized
    fun removeMany(sessionId: String, keys: Set<String>): List<ChatDeleteItem> {
        val thread = _threads.value[sessionId] ?: return emptyList()
        val (gone, kept) = thread.partition { it.key in keys }
        if (gone.isEmpty()) return emptyList()
        setThreads(_threads.value + (sessionId to kept))
        return gone.mapNotNull { row ->
            when {
                row.seq != null -> ChatDeleteItem(seq = row.seq)
                row.originId != null -> ChatDeleteItem(originId = row.originId)
                else -> null
            }
        }
    }

    /**
     * Send the text again — the retry button on a FAILED message. The dead
     * attempt is removed and a fresh optimistic one takes its place at the
     * tail, because the retry is a new arrival, not a resurrection of the old
     * one. Returns the new key for the caller to settle; null when there is
     * nothing failed to retry.
     */
    @Synchronized
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

    /**
     * The fetches themselves live in the SHARED driver — a chat tile and an
     * artifact attachment row are the same transfer with a different key. What
     * remains here is only the chat-shaped spelling of it.
     */
    val attachmentPulls = AttachmentPulls()

    /** Per-message fetch state, keyed by [ChatMessage.key]. */
    val pulls: StateFlow<Map<String, PullState>> = attachmentPulls.pulls

    fun pullState(key: String): PullState = attachmentPulls.pullState(key)

    /** Begin (or resume) a fetch of the file hanging off one message. */
    fun pullStarted(key: String, attachment: ChatAttachment): Boolean =
        attachmentPulls.pullStarted(key, attachment.sizeBytes)

    fun nextAsk(key: String, sliceBytes: Int): Long? = attachmentPulls.nextAsk(key, sliceBytes)

    fun sliceArrived(key: String, offset: Long, bytes: ByteArray, eof: Boolean): ByteArray? =
        attachmentPulls.sliceArrived(key, offset, bytes, eof)

    fun pullFailed(key: String, message: String) = attachmentPulls.pullFailed(key, message)

    /** The bytes reached the device. The tile becomes an open button. */
    fun pullSaved(key: String, location: String, uri: String) =
        attachmentPulls.pullSaved(key, location, uri)

    /** Abandon a fetch and its part-file. Nothing half-written is kept. */
    fun pullCancelled(key: String) = attachmentPulls.pullCancelled(key)

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
        setThreads(_threads.value + (sessionId to thread))
    }

    /** Every thread change goes through here, so the saved file never lags the screen. */
    private fun setThreads(next: Map<String, List<ChatMessage>>) {
        _threads.value = next
        persist()
    }

    private fun persist() = store.save(ChatSnapshot(_threads.value, cursors, sentIds.keys.toList()))

    /** One write, to the flow the screens read and the store the app restarts from. */
    private fun setUnread(sessionId: String, count: Int) {
        val next = _unreadCounts.value.toMutableMap()
        if (count <= 0) next.remove(sessionId) else next[sessionId] = count
        _unreadCounts.value = next
        unread.setCount(sessionId, count)
    }

    /** Monotonic, so two identical messages in the same millisecond stay distinct. */
    private fun nextKey(): String = "m${sequence++}"

    companion object {
        /**
         * A phone left running for a week must not accumulate an unbounded thread.
         * Oldest goes first; scrollback beyond this is the desktop's job.
         */
        private const val MAX_THREAD = 200

        /** How far back the desktop journal replays; older history cannot come back. */
        private const val JOURNAL_WINDOW_MS = 24L * 60 * 60 * 1000

        /** How many of this phone's own recently sent ids stay recognisable. */
        private const val MAX_SENT_IDS = 256

        /** A chat record that deletes an earlier one (see [MobileRecord.Chat.deletes]). */
        const val DELETED_KIND = "deleted"
    }
}
