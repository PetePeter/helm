package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * One phone, several paired desktops. Each desktop's chat journal numbers its
 * own seq from 1, so the catch-up cursor is per desktop: the regression here is
 * a Mac at seq 11 whose live pushes were all dropped as "duplicates" because a
 * busier desktop had already taken the single shared cursor into the hundreds.
 *
 * Real repository, no fakes.
 */
class ChatRepositoryMultiDesktopTest {

    private val repository = ChatRepository()

    @Test
    fun `a live record from a desktop with a lower counter is kept`() {
        repository.receive(BOX, chat("box", seq = 500, sessionId = "box-s"))

        repository.receive(MAC, chat("mac", seq = 11, sessionId = "mac-s"))

        assertEquals(listOf("mac"), repository.thread("mac-s").map { it.text })
    }

    @Test
    fun `each desktop reports its own cursor, and an unknown desktop asks for everything`() {
        repository.receive(BOX, chat("box", seq = 500, sessionId = "box-s"))
        repository.receive(MAC, chat("mac", seq = 11, sessionId = "mac-s"))

        assertEquals(500L, repository.lastSeq(BOX))
        assertEquals(11L, repository.lastSeq(MAC))
        assertEquals(0L, repository.lastSeq("never-linked"))
    }

    @Test
    fun `a replay from one desktop fills its gap regardless of the other's cursor`() {
        repository.receive(BOX, chat("box", seq = 500, sessionId = "box-s"))
        repository.receive(MAC, chat("mac 5", seq = 5, sessionId = "mac-s"))

        repository.receive(MAC, chat("mac 3", seq = 3, sessionId = "mac-s", replay = true))
        repository.receive(MAC, chat("mac 6", seq = 6, sessionId = "mac-s", replay = true))

        assertEquals(listOf("mac 3", "mac 5", "mac 6"), repository.thread("mac-s").map { it.text })
        assertEquals(6L, repository.lastSeq(MAC))
        assertEquals(500L, repository.lastSeq(BOX))
    }

    @Test
    fun `a full replay of rows already held adds no duplicates and still advances the cursor`() {
        // The v2 migration shape: rows held, cursor forgotten.
        val store = MemoryChatStore().apply {
            save(ChatSnapshot(threads = mapOf("mac-s" to listOf(row("mac 1", 1), row("mac 2", 2))), cursors = emptyMap()))
        }
        repository.useChatStore(store)

        repository.receive(MAC, chat("mac 1", seq = 1, sessionId = "mac-s", replay = true))
        repository.receive(MAC, chat("mac 2", seq = 2, sessionId = "mac-s", replay = true))
        repository.receive(MAC, chat("mac 3", seq = 3, sessionId = "mac-s", replay = true))

        assertEquals(listOf("mac 1", "mac 2", "mac 3"), repository.thread("mac-s").map { it.text })
        assertEquals(3L, repository.lastSeq(MAC))
    }

    private fun row(text: String, seq: Long) =
        ChatMessage(key = "", text = text, at = seq, fromPhone = false, seq = seq)

    private fun chat(text: String, seq: Long, sessionId: String, replay: Boolean = false) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = "work",
        text = text,
        at = seq,
        seq = seq,
        replay = replay,
    )

    private companion object {
        const val BOX = "box-machine"
        const val MAC = "mac-machine"
    }
}
