package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Thread assembly — the parts a reconnect or a busy session can get wrong. */
class ChatRepositoryTest {
    private val repository = ChatRepository()

    @Test
    fun `a reconnect backlog delivered in arrival order reads in the order it was written`() {
        repository.receive(chat(text = "first", at = 10))
        repository.receive(chat(text = "second", at = 20))
        repository.receive(chat(text = "third", at = 30))

        assertEquals(listOf("first", "second", "third"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `an outgoing message stamped by a slow phone clock still lands after the desktop reply`() {
        // Found on-device: the tablet ran 65 s behind the PC, so a phone message
        // stamped with the phone clock sorted before every desktop message whose
        // `at` was ahead of it. Ordering is by arrival, never by `at`.
        repository.sending("s1", "go on", at = 100)
        repository.receive(chat(text = "here you go", at = 165))
        repository.sending("s1", "thanks", at = 102)

        assertEquals(listOf("go on", "here you go", "thanks"), repository.thread("s1").map { it.text })
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

    @Test
    fun `removing a message deletes only the one it names and leaves the order intact`() {
        val first = repository.sending("s1", "carry on", at = 10)
        repository.receive(chat(text = "here you go", at = 165))
        val third = repository.sending("s1", "thanks", at = 102)

        repository.remove("s1", first)
        repository.remove("s1", third)

        assertEquals(listOf("here you go"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `removing an unknown key or from an absent thread touches nothing at all`() {
        repository.sending("s1", "carry on", at = 10)

        repository.remove("s1", "m99")
        repository.remove("gone", "m0")

        assertEquals(listOf("carry on"), repository.thread("s1").map { it.text })
        // A no-op must not invent the thread it was asked about.
        assertEquals(setOf("s1"), repository.threads.value.keys)
    }

    @Test
    fun `retrying a failed message replaces it with an identical Sending one`() {
        val failed = repository.sending("s1", "carry on", at = 10)
        repository.settle("s1", failed, delivered = false)

        val retried = repository.retry("s1", failed, at = 20)

        val thread = repository.thread("s1")
        assertEquals(1, thread.size)
        assertEquals("carry on", thread.single().text)
        assertEquals(Delivery.Sending, thread.single().delivery)
        assertTrue(thread.single().fromPhone)
        // A fresh key, so the caller settles this attempt without touching the old one.
        assertEquals(retried, thread.single().key)
        assertNotEquals(failed, retried)
    }

    @Test
    fun `retry is refused for anything not sitting in Failed`() {
        val sending = repository.sending("s1", "in flight", at = 10)
        val sent = repository.sending("s1", "delivered", at = 20)
        repository.settle("s1", sent, delivered = true)

        assertNull(repository.retry("s1", sending, at = 30))
        assertNull(repository.retry("s1", sent, at = 30))
        assertNull(repository.retry("gone", "m0", at = 30))
        // A refusal leaves the thread exactly as it was.
        assertEquals(2, repository.thread("s1").size)
    }

    private fun chat(text: String, at: Long, sessionId: String = "s1") =
        MobileRecord.Chat(sessionId = sessionId, sessionName = "work", text = text, at = at)
}
