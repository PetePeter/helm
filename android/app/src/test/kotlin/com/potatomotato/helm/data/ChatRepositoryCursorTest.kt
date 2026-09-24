package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The catch-up cursor: what advances it, what dedupes against it, what it must
 * never do to a record that carries no seq — and the cold-start rule: a
 * repository with no saved snapshot is a cursor at zero and a FULL journal
 * refetch. (A cursor persisted WITHOUT its threads was once the bug here; it
 * now persists only beside them — see ChatStoreTest.)
 *
 * The race pinned down here: a live fan-out record can cross the wire while
 * this phone's cursor request is still in flight, so the cursor JUMPS OVER the
 * gap the desktop is about to replay. The replayed gap then arrives stamped
 * `replay: true` at or below the cursor — and it must be filled in, not
 * dropped, or the hole in the thread lasts until the app restarts.
 *
 * Real repository, no fakes.
 */
class ChatRepositoryCursorTest {

    @Test
    fun `a seq-bearing record advances the cursor`() {
        val repository = ChatRepository()

        repository.receive(chat(text = "one", at = 10, seq = 4))

        assertEquals(4L, repository.lastSeq())
    }

    @Test
    fun `a fresh repository starts at zero, so a restart asks for the whole journal`() {
        val first = ChatRepository()
        first.receive(chat(text = "kept", at = 10, seq = 7))

        // A brand-new repository — the post-restart shape. It holds nothing and
        // must say so, even though some earlier process had reached seq 7.
        val restarted = ChatRepository()

        assertEquals(0L, restarted.lastSeq())
        assertEquals(emptyList<ChatMessage>(), restarted.thread("s1"))
    }

    @Test
    fun `a full journal replay into an empty repository renders every entry in order`() {
        val repository = ChatRepository()

        // What Helm streams after a cursor of zero: the journal, oldest first,
        // interleaved across sessions exactly as it was written.
        val journal = listOf(
            chat(text = "agent 1", at = 1, seq = 1, sessionId = "s1"),
            chat(text = "phone 1", at = 2, seq = 2, sessionId = "s2", originId = "pixel:p1"),
            chat(text = "agent 2", at = 3, seq = 3, sessionId = "s1"),
            chat(text = "agent 3", at = 4, seq = 4, sessionId = "s2"),
        )
        journal.forEach(repository::receive)

        assertEquals(listOf("agent 1", "agent 2"), repository.thread("s1").map { it.text })
        assertEquals(listOf("phone 1", "agent 3"), repository.thread("s2").map { it.text })
        assertEquals(4L, repository.lastSeq())
    }

    @Test
    fun `a replayed gap below the cursor fills in ahead of the live record that raced it`() {
        val repository = ChatRepository()

        // Live fan-out crosses while the cursor request is still in flight:
        // seq 5 lands first and the cursor jumps OVER 3 and 4. The replayed gap
        // then arrives — flagged replay, at or below the cursor — and must
        // render, in seq order, or the conversation reads with a hole in it.
        repository.receive(chat(text = "raced", at = 20, seq = 5))
        repository.receive(chat(text = "old 3", at = 3, seq = 3, replay = true))
        repository.receive(chat(text = "old 4", at = 4, seq = 4, replay = true))

        assertEquals(listOf("old 3", "old 4", "raced"), repository.thread("s1").map { it.text })
        // The gap was history, not a new high-water mark: filling it must not
        // drag the cursor backwards.
        assertEquals(5L, repository.lastSeq())
    }

    @Test
    fun `a replayed record already in the thread does not double it`() {
        val repository = ChatRepository()

        repository.receive(chat(text = "raced", at = 20, seq = 5))
        // The replay's own copy of the record that already won the race...
        repository.receive(chat(text = "raced again", at = 5, seq = 5, replay = true))
        // ...and the same gap record said twice, as a re-run replay would.
        repository.receive(chat(text = "old 3", at = 3, seq = 3, replay = true))
        repository.receive(chat(text = "old 3", at = 3, seq = 3, replay = true))

        assertEquals(listOf("old 3", "raced"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `a live record at or below the cursor is still dropped, so a race cannot double it`() {
        val repository = ChatRepository()
        repository.receive(chat(text = "live", at = 10, seq = 5))

        // A LIVE record (no replay flag) at or below the cursor can only be a
        // duplicate of something already held: the desktop numbers forward, so
        // live fan-out never re-sends old news unflagged.
        repository.receive(chat(text = "live again", at = 10, seq = 5))

        assertEquals(listOf("live"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `a replayed record below the cursor never moves it`() {
        val repository = ChatRepository()
        repository.receive(chat(text = "live", at = 10, seq = 9))

        repository.receive(chat(text = "old", at = 3, seq = 3, replay = true))

        // The next report must keep asking after 9, not after the gap.
        assertEquals(9L, repository.lastSeq())
    }

    @Test
    fun `a record without a seq leaves the cursor untouched, so an old desktop degrades safely`() {
        val repository = ChatRepository()
        repository.receive(chat(text = "numbered", at = 10, seq = 9))

        repository.receive(chat(text = "unnumbered", at = 11))

        assertEquals(9L, repository.lastSeq())
        assertEquals(listOf("numbered", "unnumbered"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `an unnumbered message is otherwise treated exactly like a numbered one`() {
        val repository = ChatRepository()
        repository.receive(chat(text = "unnumbered", at = 11))

        assertEquals(1, repository.unreadCounts.value["s1"])
        assertEquals("unnumbered", repository.thread("s1").single().text)
    }

    private fun chat(
        text: String,
        at: Long,
        seq: Long? = null,
        sessionId: String = "s1",
        originId: String? = null,
        replay: Boolean = false,
    ) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = "work",
        text = text,
        at = at,
        seq = seq,
        originId = originId,
        replay = replay,
    )
}
