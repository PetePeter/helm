package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The unread counter — what counts, what never counts, and what clears it.
 * Real repository, real store, no fakes beyond the store being memory-only.
 */
class ChatRepositoryUnreadTest {

    @Test
    fun `an inbound message for a session nobody is reading counts as unread`() {
        val store = MemoryUnreadStore()
        val repository = ChatRepository(store)

        repository.receive(chat(text = "ping", sessionId = "s1"))

        assertEquals(1, repository.unreadCounts.value["s1"])
        // And it lands in the store, so a process death cannot lose the badge.
        assertEquals(mapOf("s1" to 1), store.counts())
    }

    @Test
    fun `a message landing in the thread the user is reading does not count`() {
        val repository = ChatRepository(MemoryUnreadStore())
        repository.reading("s1")

        repository.receive(chat(text = "still here", sessionId = "s1"))

        assertTrue(repository.unreadCounts.value.isEmpty())
    }

    @Test
    fun `opening a thread clears the count it arrived with`() {
        val store = MemoryUnreadStore()
        val repository = ChatRepository(store)
        repository.receive(chat(text = "one", sessionId = "s1"))
        repository.receive(chat(text = "two", sessionId = "s1"))

        repository.reading("s1")

        assertTrue(repository.unreadCounts.value.isEmpty())
        assertTrue(store.counts().isEmpty())
    }

    @Test
    fun `leaving a thread does not resurrect a cleared count`() {
        val repository = ChatRepository(MemoryUnreadStore())
        repository.receive(chat(text = "hello", sessionId = "s1"))
        repository.reading("s1")

        repository.reading(null)

        assertTrue(repository.unreadCounts.value.isEmpty())
    }

    @Test
    fun `two sessions count independently and markRead touches only the one it names`() {
        val repository = ChatRepository(MemoryUnreadStore())
        repository.receive(chat(text = "alpha", sessionId = "s1"))
        repository.receive(chat(text = "beta", sessionId = "s2"))
        repository.receive(chat(text = "beta again", sessionId = "s2"))

        repository.markRead("s2")

        assertEquals(1, repository.unreadCounts.value["s1"])
        assertEquals(null, repository.unreadCounts.value["s2"])
    }

    @Test
    fun `an outgoing message never counts as unread`() {
        val repository = ChatRepository(MemoryUnreadStore())

        repository.sending("s1", "carry on", at = 10)

        assertTrue(repository.unreadCounts.value.isEmpty())
    }

    @Test
    fun `counts survive a restart by starting from what the store remembers`() {
        val store = MemoryUnreadStore()
        store.setCount("s1", 4)

        val repository = ChatRepository(store)

        assertEquals(4, repository.unreadCounts.value["s1"])
    }

    @Test
    fun `a store that remembers nothing starts every session at zero`() {
        val repository = ChatRepository(MemoryUnreadStore())

        assertTrue(repository.unreadCounts.value.isEmpty())
        assertEquals(0, repository.unreadCounts.value["never-seen"] ?: 0)
    }

    private fun chat(text: String, at: Long = 10, sessionId: String = "s1") =
        MobileRecord.Chat(sessionId = sessionId, sessionName = "work", text = text, at = at)
}
