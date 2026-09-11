package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Thread assembly — the parts a reconnect or a busy session can get wrong. */
class ChatRepositoryTest {
    private val repository = ChatRepository()

    @Test
    fun `a backlog delivered out of order still reads in the order it was written`() {
        repository.receive(chat(text = "third", at = 30))
        repository.receive(chat(text = "first", at = 10))
        repository.receive(chat(text = "second", at = 20))

        assertEquals(listOf("first", "second", "third"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `two identical messages in the same millisecond stay two messages`() {
        repository.receive(chat(text = "done", at = 10))
        repository.receive(chat(text = "done", at = 10))

        val thread = repository.thread("s1")
        assertEquals(2, thread.size)
        assertEquals(2, thread.map { it.key }.distinct().size)
    }

    @Test
    fun `an endless session cannot grow the thread without bound`() {
        repeat(250) { repository.receive(chat(text = "line $it", at = it.toLong())) }

        val thread = repository.thread("s1")
        assertEquals(200, thread.size)
        // The oldest go first — the newest is what the user is reading.
        assertEquals("line 249", thread.last().text)
    }

    @Test
    fun `settling a message touches only the one it names`() {
        val first = repository.sending("s1", "carry on", at = 10)
        repository.sending("s1", "and again", at = 20)

        repository.settle("s1", first, delivered = true)

        val thread = repository.thread("s1")
        assertEquals(Delivery.Sent, thread[0].delivery)
        assertEquals(Delivery.Sending, thread[1].delivery)
    }

    @Test
    fun `settling a thread that no longer exists is a no-op, not a crash`() {
        repository.settle("gone", "m0", delivered = true)

        assertTrue(repository.thread("gone").isEmpty())
    }

    @Test
    fun `a voice attachment survives into the thread`() {
        repository.receive(chat(text = "", at = 10).copy(filePath = "C:\\tmp\\note.ogg", voice = true))

        val message = repository.thread("s1").single()
        assertEquals("C:\\tmp\\note.ogg", message.filePath)
        assertTrue(message.voice)
    }

    private fun chat(text: String, at: Long, sessionId: String = "s1") =
        MobileRecord.Chat(sessionId = sessionId, sessionName = "work", text = text, at = at)
}
