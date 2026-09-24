package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Chat threads surviving a restart: the real [ChatRepository] over the real
 * [FileChatStore] in a temp dir, writes run inline so a "restart" is simply a
 * second repository over the same file.
 */
class ChatStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val file: File get() = File(temp.root, "chat-threads.json")

    private fun store() = FileChatStore(file) { it.run() }

    private fun repository() = ChatRepository().apply { useChatStore(store()) }

    @Test
    fun `a restart restores the threads and the cursor`() {
        repository().apply {
            receive(chat("one", seq = 1))
            receive(chat("two", seq = 2, sessionId = "s2"))
            sending("s1", "mine", at = 5)
        }

        val restarted = repository()

        assertEquals(2L, restarted.lastSeq())
        assertEquals(listOf("one", "mine"), restarted.thread("s1").map { it.text })
        assertEquals(listOf("two"), restarted.thread("s2").map { it.text })
        // An unsettled send cannot settle after the process died.
        assertEquals(Delivery.Failed, restarted.thread("s1").last().delivery)
    }

    @Test
    fun `restored rows get fresh distinct keys`() {
        repository().apply { receive(chat("a", seq = 1)); receive(chat("b", seq = 2)) }

        val restarted = repository()
        restarted.receive(chat("c", seq = 3))

        val keys = restarted.thread("s1").map { it.key }
        assertEquals(keys.size, keys.toSet().size)
    }

    @Test
    fun `after a restart the replay adds only what is past the cursor`() {
        repository().apply { receive(chat("one", seq = 1)); receive(chat("two", seq = 2)) }

        val restarted = repository()
        // The desktop replays from the saved cursor; a stray older one must not double.
        restarted.receive(chat("two", seq = 2, replay = true))
        restarted.receive(chat("three", seq = 3, replay = true))

        assertEquals(listOf("one", "two", "three"), restarted.thread("s1").map { it.text })
        assertEquals(3L, restarted.lastSeq())
    }

    @Test
    fun `an own echo sent before the restart is still dropped after it`() {
        repository().apply { sending("s1", "hi", at = 1); sent("pixel:c1") }

        val restarted = repository()
        restarted.receive(chat("hi", seq = 1, originId = "pixel:c1", replay = true))

        assertEquals(listOf("hi"), restarted.thread("s1").map { it.text })
    }

    @Test
    fun `no file is a cold start at cursor zero`() {
        val repository = repository()

        assertEquals(0L, repository.lastSeq())
        assertEquals(emptyMap<String, List<ChatMessage>>(), repository.threads.value)
    }

    @Test
    fun `a corrupt file is a cold start, not a crash`() {
        file.writeText("{not json")

        assertNull(store().load())
        assertEquals(0L, repository().lastSeq())
    }

    @Test
    fun `each saved thread keeps only the newest rows`() {
        repository().apply { (1L..250L).forEach { receive(chat("m$it", seq = it)) } }

        val thread = repository().thread("s1")

        assertEquals(200, thread.size)
        assertEquals("m250", thread.last().text)
    }

    @Test
    fun `threads of sessions the desktop no longer lists are pruned, on disk too`() {
        repository().apply {
            receive(chat("keep", seq = 1, sessionId = "s1"))
            receive(chat("gone", seq = 2, sessionId = "s2"))
            retainSessions(setOf("s1"))
        }

        val restarted = repository()

        assertEquals(setOf("s1"), restarted.threads.value.keys)
        assertEquals(2L, restarted.lastSeq())
    }

    private fun chat(
        text: String,
        seq: Long? = null,
        sessionId: String = "s1",
        originId: String? = null,
        replay: Boolean = false,
    ) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = "work",
        text = text,
        at = seq ?: 0,
        seq = seq,
        originId = originId,
        replay = replay,
    )
}
