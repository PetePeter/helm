package com.potatomotato.helm.data

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Paging a file across the link.
 *
 * Every case here is a way the phone could end up holding a file that LOOKS
 * complete and is not — a duplicate slice appended twice, a gap stitched over,
 * a partial handed to a viewer. A corrupt photo that opens is worse than a
 * failed transfer the user can retry.
 */
class AttachmentTransferTest {

    @Test
    fun `slices in order reassemble to the exact bytes`() {
        val transfer = AttachmentTransfer(total = 6)

        assertTrue(transfer.accept(0, byteArrayOf(1, 2, 3), eof = false))
        assertEquals(3L, transfer.nextOffset())
        assertTrue(transfer.accept(3, byteArrayOf(4, 5, 6), eof = true))

        assertTrue(transfer.done)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), transfer.bytes())
    }

    @Test
    fun `a repeated slice is refused rather than appended twice`() {
        val transfer = AttachmentTransfer(total = 6)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        // A link that answers one ask twice would otherwise double the bytes and
        // still report a plausible-looking total.
        assertFalse(transfer.accept(0, byteArrayOf(1, 2, 3), eof = false))
        assertEquals(3L, transfer.received)
    }

    @Test
    fun `a slice that skips ahead is refused rather than stitched over a hole`() {
        val transfer = AttachmentTransfer(total = 9)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        assertFalse(transfer.accept(6, byteArrayOf(7, 8, 9), eof = true))
        assertFalse(transfer.done)
    }

    @Test
    fun `nothing arrives after the end`() {
        val transfer = AttachmentTransfer(total = 3)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = true)

        assertFalse(transfer.accept(3, byteArrayOf(4), eof = true))
        assertArrayEquals(byteArrayOf(1, 2, 3), transfer.bytes())
    }

    @Test
    fun `an unfinished transfer refuses to hand over a truncated file`() {
        val transfer = AttachmentTransfer(total = 6)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        // Nothing downstream could tell a short file from a complete one.
        val error = runCatching { transfer.bytes() }.exceptionOrNull()
        assertTrue(error is IllegalStateException)
    }

    @Test
    fun `an empty final slice ends the transfer without adding to it`() {
        // The desktop answers an offset that lands exactly on the end with no
        // bytes and eof — a correct loop asks once more.
        val transfer = AttachmentTransfer(total = 3)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        assertTrue(transfer.accept(3, ByteArray(0), eof = true))
        assertArrayEquals(byteArrayOf(1, 2, 3), transfer.bytes())
    }
}

/** The repository half: what the tile shows, and what survives a stumble. */
class ChatRepositoryPullTest {
    private val chats = ChatRepository()

    private fun arriveWithFile(): String {
        chats.receive(
            MobileRecord.Chat(
                sessionId = "s1",
                sessionName = "work",
                text = "here it is",
                at = 1L,
                artifactId = "art-1",
                attachmentId = "att-1",
                filename = "holiday.jpg",
                mimeType = "image/jpeg",
                sizeBytes = 6,
            ),
        )
        return chats.thread("s1").last().key
    }

    @Test
    fun `an attachment record becomes a message with a file on it`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!

        assertEquals("art-1", attachment.artifactId)
        assertEquals("holiday.jpg", attachment.filename)
        assertEquals(6L, attachment.sizeBytes)
        assertEquals(PullState.Idle, chats.pullState(key))
    }

    @Test
    fun `an ordinary message carries no file`() {
        chats.receive(MobileRecord.Chat(sessionId = "s1", sessionName = "work", text = "hi", at = 1L))

        assertNull(chats.thread("s1").last().attachment)
    }

    @Test
    fun `an artifact notice is not mistaken for a file to fetch`() {
        // kind:'artifact' records carry artifactId too, and there is nothing to
        // pull: without an attachmentId the tile must not appear.
        chats.receive(
            MobileRecord.Chat(
                sessionId = "s1",
                sessionName = "work",
                text = "Report",
                at = 1L,
                kind = "artifact",
                artifactId = "art-1",
                title = "Report",
            ),
        )

        assertNull(chats.thread("s1").lastOrNull()?.attachment)
    }

    @Test
    fun `a fetch reports progress and completes with the whole file`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!

        assertEquals(0L, chats.pullStarted(key, attachment))
        assertNull(chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false))
        assertEquals(PullState.Pulling(3, 6), chats.pullState(key))

        val whole = chats.sliceArrived(key, 3, byteArrayOf(4, 5, 6), eof = true)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), whole)

        chats.pullSaved(key, "Downloads/holiday.jpg")
        assertEquals(PullState.Ready("Downloads/holiday.jpg"), chats.pullState(key))
    }

    @Test
    fun `a second tap cannot start a second loop into the same buffer`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)

        assertNull(chats.pullStarted(key, attachment))
    }

    @Test
    fun `a retry resumes from what already arrived`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        chats.pullFailed(key, "the link dropped")
        assertEquals(PullState.Failed("the link dropped"), chats.pullState(key))

        // On a slow radio, restarting from zero is the difference between a lost
        // minute and a lost transfer.
        assertEquals(3L, chats.pullStarted(key, attachment))
    }

    @Test
    fun `a slice that does not fit fails the tile instead of looping forever`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        assertNull(chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false))
        assertTrue(chats.pullState(key) is PullState.Failed)
    }

    @Test
    fun `cancelling throws the part away`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        chats.pullCancelled(key)

        assertEquals(PullState.Idle, chats.pullState(key))
        // Nothing half-written survives: the next attempt starts clean.
        assertEquals(0L, chats.pullStarted(key, attachment))
    }
}
