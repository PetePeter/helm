package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
            receive(DESK, chat("one", seq = 1))
            receive(DESK, chat("two", seq = 2, sessionId = "s2"))
            sending("s1", "mine", at = 5)
        }

        val restarted = repository()

        assertEquals(2L, restarted.lastSeq(DESK))
        assertEquals(listOf("one", "mine"), restarted.thread("s1").map { it.text })
        assertEquals(listOf("two"), restarted.thread("s2").map { it.text })
        // An unsettled send cannot settle after the process died.
        assertEquals(Delivery.Failed, restarted.thread("s1").last().delivery)
    }

    @Test
    fun `reply thought counts survive a restart`() {
        repository().receive(DESK, chat("answer", seq = 1, thoughtCount = 3))

        val restored = repository().thread("s1").single()

        assertEquals(3, restored.thoughtCount)
    }

    @Test
    fun `ComfyUI profile size and input image survive a restart`() {
        repository().sending(
            "s1", "portrait", at = 7, comfyProfileId = "lustify", comfyImageSizeId = "4k-portrait",
            comfyInputImagePath = "C:\\Users\\oscar\\Helm\\tmp\\inbox\\one\\source.png",
            comfyInputAttachmentIds = listOf("ref-1", "ref-2"),
        )

        val restored = repository().thread("s1").single()

        assertEquals("lustify", restored.comfyProfileId)
        assertEquals("4k-portrait", restored.comfyImageSizeId)
        assertEquals("C:\\Users\\oscar\\Helm\\tmp\\inbox\\one\\source.png", restored.comfyInputImagePath)
        assertEquals(listOf("ref-1", "ref-2"), restored.comfyInputAttachmentIds)
    }

    @Test
    fun `gallery selections survive a restart and new images default included`() {
        repository().apply {
            setComfyReferenceSelection("s1", setOf("old", "new"), setOf("new"))
        }

        val restarted = repository()

        assertFalse(restarted.isComfyReferenceIncluded("s1", "old"))
        assertTrue(restarted.isComfyReferenceIncluded("s1", "new"))
        assertTrue(restarted.isComfyReferenceIncluded("s1", "future"))
    }

    @Test
    fun `rapid gallery checks accumulate instead of replacing the previous reference`() {
        val first = nextComfyReferenceSelection(emptySet(), "ref-1", included = true, maxReferences = 2)
        val second = nextComfyReferenceSelection(first, "ref-2", included = true, maxReferences = 2)

        assertEquals(setOf("ref-1", "ref-2"), second)
        assertEquals(second, nextComfyReferenceSelection(second, "ref-3", included = true, maxReferences = 2))
    }

    @Test
    fun `deleting a gallery image removes its stored reference from chat rows and retry data`() {
        val repo = repository()
        repo.setComfyReferenceSelection("s1", setOf("ref-1", "ref-2"), setOf("ref-2"))
        repo.receive(DESK, chat("Generated image.", seq = 1).copy(
            artifactId = "artifact-1",
            attachmentId = "ref-1",
            filename = "generated.png",
            mimeType = "image/png",
            sizeBytes = 10,
        ))
        val retryKey = repo.sending("s1", "revise", at = 2, comfyInputAttachmentIds = listOf("ref-1", "ref-2"))

        repo.removeAttachmentReference("s1", "artifact-1", "ref-1")

        assertNull(repo.thread("s1").first { it.key != retryKey }.attachment)
        assertEquals(listOf("ref-2"), repo.thread("s1").first { it.key == retryKey }.comfyInputAttachmentIds)
        assertTrue(repo.isComfyReferenceIncluded("s1", "ref-1"))
    }

    @Test
    fun `restored rows get fresh distinct keys`() {
        repository().apply { receive(DESK, chat("a", seq = 1)); receive(DESK, chat("b", seq = 2)) }

        val restarted = repository()
        restarted.receive(DESK, chat("c", seq = 3))

        val keys = restarted.thread("s1").map { it.key }
        assertEquals(keys.size, keys.toSet().size)
    }

    @Test
    fun `after a restart the replay adds only what is past the cursor`() {
        repository().apply { receive(DESK, chat("one", seq = 1)); receive(DESK, chat("two", seq = 2)) }

        val restarted = repository()
        // The desktop replays from the saved cursor; a stray older one must not double.
        restarted.receive(DESK, chat("two", seq = 2, replay = true))
        restarted.receive(DESK, chat("three", seq = 3, replay = true))

        assertEquals(listOf("one", "two", "three"), restarted.thread("s1").map { it.text })
        assertEquals(3L, restarted.lastSeq(DESK))
    }

    @Test
    fun `an own echo sent before the restart is still dropped after it`() {
        repository().apply { sending("s1", "hi", at = 1); sent("pixel:c1") }

        val restarted = repository()
        restarted.receive(DESK, chat("hi", seq = 1, originId = "pixel:c1", replay = true))

        assertEquals(listOf("hi"), restarted.thread("s1").map { it.text })
    }

    @Test
    fun `no file is a cold start at cursor zero`() {
        val repository = repository()

        assertEquals(0L, repository.lastSeq(DESK))
        assertEquals(emptyMap<String, List<ChatMessage>>(), repository.threads.value)
    }

    @Test
    fun `a corrupt file is a cold start, not a crash`() {
        file.writeText("{not json")

        assertNull(store().load())
        assertEquals(0L, repository().lastSeq(DESK))
    }

    @Test
    fun `each saved thread keeps only the newest rows`() {
        repository().apply { (1L..250L).forEach { receive(DESK, chat("m$it", seq = it)) } }

        val thread = repository().thread("s1")

        assertEquals(200, thread.size)
        assertEquals("m250", thread.last().text)
    }

    @Test
    fun `an unlisted thread idle past the journal window is pruned, on disk too`() {
        repository().apply {
            receive(DESK, chat("keep", seq = 1, sessionId = "s1"))
            receive(DESK, chat("gone", seq = 2, sessionId = "s2", at = NOW - DAY - 1))
            retainSessions(setOf("s1"), now = NOW)
        }

        val restarted = repository()

        assertEquals(setOf("s1"), restarted.threads.value.keys)
        assertEquals(2L, restarted.lastSeq(DESK))
    }

    // Regression: one short session_list (a desktop mid-restart listed 1 of 4)
    // erased every other thread, and the high cursor meant nothing refilled them.
    @Test
    fun `a short session list does not erase a recent thread`() {
        val repo = repository().apply {
            receive(DESK, chat("recent", seq = 1, sessionId = "s2", at = NOW - 1_000))
            retainSessions(setOf("s1"), now = NOW)
        }

        assertEquals(listOf("recent"), repo.thread("s2").map { it.text })
    }

    @Test
    fun `a version 1 snapshot keeps its threads but reports cursor zero, so the journal refills`() {
        file.writeText("""{"v":1,"lastSeq":42,"sentIds":[],"threads":{}}""")

        assertEquals(0L, repository().lastSeq(DESK))
    }

    @Test
    fun `each desktop's cursor survives a restart on its own`() {
        repository().apply {
            receive("box", chat("box", seq = 500, sessionId = "box-s"))
            receive("mac", chat("mac", seq = 11, sessionId = "mac-s"))
        }

        val restarted = repository()

        assertEquals(500L, restarted.lastSeq("box"))
        assertEquals(11L, restarted.lastSeq("mac"))
    }

    @Test
    fun `a version 2 snapshot keeps its threads but forgets its single cursor - no desktop can own it`() {
        file.writeText(
            """{"v":2,"lastSeq":500,"sentIds":[],"threads":{"s1":[{"text":"kept","at":1,"fromPhone":false,"seq":7}]}}""",
        )

        val repository = repository()

        assertEquals(0L, repository.lastSeq(DESK))
        assertEquals(listOf("kept"), repository.thread("s1").map { it.text })
    }

    private fun chat(
        text: String,
        seq: Long? = null,
        sessionId: String = "s1",
        originId: String? = null,
        replay: Boolean = false,
        at: Long = seq ?: 0,
        thoughtCount: Int? = null,
    ) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = "work",
        text = text,
        at = at,
        seq = seq,
        originId = originId,
        replay = replay,
        thoughtCount = thoughtCount,
    )

    private companion object {
        const val DAY = 24L * 60 * 60 * 1000
        const val NOW = 10L * DAY
    }
}
