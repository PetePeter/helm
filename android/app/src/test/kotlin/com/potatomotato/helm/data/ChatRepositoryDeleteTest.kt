package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Deleting chat rows so the DESKTOP can delete its copy too: what each removed
 * row is named by on the wire, how this phone's own sends keep a name at all,
 * and how a tombstone from elsewhere takes a row away without ever showing.
 *
 * Real repository, no fakes.
 */
class ChatRepositoryDeleteTest {

    @Test
    fun `removeMany names desktop rows by seq, own sends by originId, and failed sends by nothing`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat("from helm", seq = 3))
        val sent = repository.sending("s1", "mine", at = 20)
        repository.sent("desk-1:c9", "s1", sent)
        val failed = repository.sending("s1", "never left", at = 30)
        repository.settle("s1", failed, delivered = false)
        val keys = repository.thread("s1").map { it.key }.toSet()

        val items = repository.removeMany("s1", keys)

        assertEquals(
            listOf(ChatDeleteItem(seq = 3), ChatDeleteItem(originId = "desk-1:c9")),
            items,
        )
        assertEquals(emptyList<ChatMessage>(), repository.thread("s1"))
    }

    @Test
    fun `removeMany keeps unselected rows in arrival order`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat("a", seq = 1))
        repository.receive(DESK, chat("b", seq = 2))
        repository.receive(DESK, chat("c", seq = 3))
        val middle = repository.thread("s1")[1].key

        repository.removeMany("s1", setOf(middle))

        assertEquals(listOf("a", "c"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `an own send keeps its originId through a store round trip`() {
        val store = MemoryChatStore()
        val repository = ChatRepository(store = store)
        val key = repository.sending("s1", "mine", at = 5)
        repository.sent("desk-1:c1", "s1", key)

        val restarted = ChatRepository()
        restarted.useChatStore(store)

        assertEquals("desk-1:c1", restarted.thread("s1").single().originId)
    }

    @Test
    fun `a tombstone removes the row it names and is never shown`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat("keep", seq = 1))
        repository.receive(DESK, chat("gone", seq = 2))

        repository.receive(DESK, tombstone(seq = 3, deletes = 2))

        assertEquals(listOf("keep"), repository.thread("s1").map { it.text })
        assertEquals(3L, repository.lastSeq(DESK))
    }

    @Test
    fun `a replayed tombstone below the cursor still applies, a live duplicate does not re-run`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat("gone", seq = 2))
        repository.receive(DESK, chat("later", seq = 9))

        repository.receive(DESK, tombstone(seq = 5, deletes = 2, replay = true))

        assertEquals(listOf("later"), repository.thread("s1").map { it.text })
        assertEquals(9L, repository.lastSeq(DESK))
    }

    @Test
    fun `a tombstone for a row this phone never held only moves the cursor`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat("keep", seq = 1))

        repository.receive(DESK, tombstone(seq = 4, deletes = 99))

        assertEquals(listOf("keep"), repository.thread("s1").map { it.text })
        assertEquals(4L, repository.lastSeq(DESK))
    }

    @Test
    fun `reply stats render context in thousands with one decimal and drop zero tools`() {
        assertEquals("ctx 12.3k · 4 tools", replyStats(12_345, 4))
        assertEquals("ctx 850 · 1 tool", replyStats(850, 1))
        assertEquals("ctx 2.0k", replyStats(2_000, 0))
        assertNull(replyStats(null, null))
    }

    @Test
    fun `range selection covers everything between the first and last selected, in thread order`() {
        val thread = listOf("a", "b", "c", "d", "e")

        assertEquals(setOf("b", "c", "d"), rangeSelection(thread, setOf("d", "b")))
        assertEquals(setOf("a", "b", "c", "d", "e", "gone"), rangeSelection(thread, setOf("gone", "c", "e", "a")))
        assertEquals(setOf("gone"), rangeSelection(thread, setOf("gone")))
    }

    private fun chat(text: String, seq: Long) = MobileRecord.Chat(
        sessionId = "s1", sessionName = "work", text = text, at = seq * 10, seq = seq,
    )

    private fun tombstone(seq: Long, deletes: Long, replay: Boolean = false) = MobileRecord.Chat(
        sessionId = "s1", sessionName = "work", text = "", at = 0, kind = ChatRepository.DELETED_KIND,
        seq = seq, replay = replay, deletes = deletes,
    )
}
