package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The catch-up cursor: what advances it, what dedupes against it, what it must
 * never do to a record that carries no seq — and the cold-start rule that drove
 * the design: the cursor lives in memory, so an app restart is a cursor at zero
 * and a FULL journal refetch. Persisting the cursor was the bug it fixes — a
 * persisted cursor told Helm "seen through seq N" about a process that held
 * nothing, and the restart never refilled.
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
    fun `a live record that raced the replay is kept once, and the replay never doubles it`() {
        val repository = ChatRepository()

        // Live fan-out arrives while the refetch is still in flight — seq 5
        // lands before the replay reaches it. The cursor advanced to 5, so the
        // replayed copies at or below 5 are dropped: seq is the only order the
        // two sends share, and the drop is what keeps one message one row.
        repository.receive(chat(text = "raced", at = 20, seq = 5))
        repository.receive(chat(text = "old 3", at = 3, seq = 3))
        repository.receive(chat(text = "old 4", at = 4, seq = 4))
        // The replay's own copy of seq 5, behind the live one that already won.
        repository.receive(chat(text = "raced again", at = 5, seq = 5))

        assertEquals(listOf("raced"), repository.thread("s1").map { it.text })
        assertEquals(5L, repository.lastSeq())
    }

    @Test
    fun `a replayed record at or below the cursor is dropped, so a race cannot double it`() {
        val repository = ChatRepository()
        repository.receive(chat(text = "live", at = 10, seq = 5))

        // The desktop replayed the gap while the live copy raced it here.
        repository.receive(chat(text = "live again", at = 10, seq = 5))
        repository.receive(chat(text = "older", at = 9, seq = 3))

        assertEquals(listOf("live"), repository.thread("s1").map { it.text })
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
    ) = MobileRecord.Chat(sessionId = sessionId, sessionName = "work", text = text, at = at, seq = seq, originId = originId)
}
