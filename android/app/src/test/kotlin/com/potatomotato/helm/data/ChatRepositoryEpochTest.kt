package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The journal epoch: Helm's answer to a cursor report names the journal it
 * numbers from. A desktop whose journal was recreated (config wiped) numbers
 * from 1 again — the regression this pins down is a phone at seq 19610 dropping
 * every new live record as a "duplicate" forever.
 *
 * Real repository, no fakes.
 */
class ChatRepositoryEpochTest {

    @Test
    fun `a different epoch resets the cursor so new low seqs are shown`() {
        val repository = ChatRepository()
        repository.adoptJournal(DESK, epoch = "A", latestSeq = 19610)
        repository.receive(DESK, chat(text = "old", at = 1, seq = 19610))

        assertTrue(repository.adoptJournal(DESK, epoch = "B", latestSeq = 0))
        assertEquals(0L, repository.lastSeq(DESK))

        repository.receive(DESK, chat(text = "new", at = 2, seq = 1))
        assertEquals(listOf("old", "new"), repository.thread("s1").map { it.text })
        assertEquals(1L, repository.lastSeq(DESK))
    }

    @Test
    fun `a reset forgets old row seqs so a reused number is not mistaken for a held row`() {
        val repository = ChatRepository()
        repository.adoptJournal(DESK, epoch = "A", latestSeq = 5)
        repository.receive(DESK, chat(text = "old five", at = 1, seq = 5))

        repository.adoptJournal(DESK, epoch = "B", latestSeq = 5)
        repository.receive(DESK, chat(text = "new five", at = 2, seq = 5, replay = true))

        assertEquals(listOf("old five", "new five"), repository.thread("s1").map { it.text })
    }

    @Test
    fun `the same epoch changes nothing and duplicates still drop`() {
        val repository = ChatRepository()
        repository.adoptJournal(DESK, epoch = "A", latestSeq = 3)
        repository.receive(DESK, chat(text = "three", at = 1, seq = 3))

        assertFalse(repository.adoptJournal(DESK, epoch = "A", latestSeq = 3))
        repository.receive(DESK, chat(text = "three", at = 1, seq = 3))

        assertEquals(3L, repository.lastSeq(DESK))
        assertEquals(1, repository.thread("s1").size)
    }

    @Test
    fun `a cursor from before epochs is adopted when the journal still covers it`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat(text = "held", at = 1, seq = 40))

        assertFalse(repository.adoptJournal(DESK, epoch = "A", latestSeq = 55))
        assertEquals(40L, repository.lastSeq(DESK))
    }

    @Test
    fun `a cursor from before epochs that is ahead of the journal resets`() {
        val repository = ChatRepository()
        repository.receive(DESK, chat(text = "held", at = 1, seq = 19610))

        assertTrue(repository.adoptJournal(DESK, epoch = "A", latestSeq = 15))
        assertEquals(0L, repository.lastSeq(DESK))
    }

    @Test
    fun `another desktop's cursor is untouched by a reset`() {
        val repository = ChatRepository()
        repository.adoptJournal(DESK, epoch = "A", latestSeq = 9)
        repository.adoptJournal("desk-2", epoch = "X", latestSeq = 9)
        repository.receive(DESK, chat(text = "a", at = 1, seq = 9))
        repository.receive("desk-2", chat(text = "b", at = 1, seq = 9, sessionId = "s2"))

        repository.adoptJournal(DESK, epoch = "B", latestSeq = 0)

        assertEquals(9L, repository.lastSeq("desk-2"))
    }

    @Test
    fun `the epoch survives a restart with the snapshot`() {
        val store = MemoryChatStore()
        val first = ChatRepository(store = store)
        first.adoptJournal(DESK, epoch = "A", latestSeq = 2)
        first.receive(DESK, chat(text = "kept", at = 1, seq = 2))

        val restarted = ChatRepository()
        restarted.useChatStore(store)

        assertFalse(restarted.adoptJournal(DESK, epoch = "A", latestSeq = 2))
        assertEquals(2L, restarted.lastSeq(DESK))
    }

    private fun chat(
        text: String,
        at: Long,
        seq: Long? = null,
        sessionId: String = "s1",
        replay: Boolean = false,
    ) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = "work",
        text = text,
        at = at,
        seq = seq,
        replay = replay,
    )
}
