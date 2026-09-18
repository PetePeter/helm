package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phone-origin echoes. The desktop journals an ACCEPTED reply and replays it
 * back to the phone that sent it, so this end must recognise its own words or
 * every catch-up would double every message the user typed.
 *
 * Real repository, memory-only stores.
 */
class ChatRepositoryEchoTest {

    @Test
    fun `an echo of a reply this phone sent is dropped, and the cursor still advances`() {
        val repository = ChatRepository()
        repository.sending("s1", "on my way", at = 10)
        repository.sent("phone-machine:p2")

        repository.receive(chat(text = "on my way", at = 11, seq = 3, originId = "phone-machine:p2"))

        // One row — the optimistic copy. A second would read as the user having
        // said it twice.
        assertEquals(1, repository.thread("s1").size)
        // The cursor advanced BEFORE the drop: forgetting history this phone
        // holds is exactly the gap the cursor exists to close, and the echo is
        // history it now holds whether or not it was shown twice.
        assertEquals(3L, repository.lastSeq())
    }

    @Test
    fun `an echo another phone sent is kept and renders as a phone message`() {
        val repository = ChatRepository()
        repository.sending("s1", "from pixel", at = 10)
        repository.sent("phone-machine:p1")

        repository.receive(chat(text = "from tablet", at = 11, seq = 4, originId = "tablet-machine:p1"))

        // The pixel copy is this phone's own optimistic row; the tablet's echo
        // lands beside it, NOT dropped by a sent id that was never its own.
        assertEquals(listOf("from pixel", "from tablet"), repository.thread("s1").map { it.text })
        assertTrue(repository.thread("s1").last().fromPhone)
    }

    @Test
    fun `an echo that carries no seq still dedupes, because ids outlive numbering`() {
        val repository = ChatRepository()
        repository.sending("s1", "hi", at = 10)
        repository.sent("phone-machine:p1")

        // An old desktop build replays by id alone; the drop must not depend on
        // the cursor having already covered it.
        repository.receive(chat(text = "hi", at = 11, originId = "phone-machine:p1"))

        assertEquals(1, repository.thread("s1").size)
        assertEquals(0L, repository.lastSeq())
    }

    @Test
    fun `a sent id that has fallen out of the bounded set no longer dedupes`() {
        val repository = ChatRepository()
        repository.sending("s1", "old", at = 10)
        repository.sent("phone-machine:p0")
        // Flood the bounded set well past any sane bound.
        for (i in 1..400) repository.sent("phone-machine:later$i")

        repository.receive(chat(text = "old", at = 11, seq = 1, originId = "phone-machine:p0"))

        assertEquals(2, repository.thread("s1").size)
    }

    private fun chat(text: String, at: Long, seq: Long? = null, originId: String? = null, sessionId: String = "s1") =
        MobileRecord.Chat(sessionId = sessionId, sessionName = "work", text = text, at = at, seq = seq, originId = originId)
}
