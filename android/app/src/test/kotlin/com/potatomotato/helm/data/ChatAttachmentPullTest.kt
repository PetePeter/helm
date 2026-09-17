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

    /** Ask for everything the window allows, as the client's loop does. */
    private fun AttachmentTransfer.askAll(slice: Int, window: Int = 4): List<Long> =
        generateSequence { nextAsk(slice, window) }.toList()

    @Test
    fun `slices in order reassemble to the exact bytes`() {
        val transfer = AttachmentTransfer(total = 6)
        transfer.askAll(slice = 3)

        assertTrue(transfer.accept(0, byteArrayOf(1, 2, 3), eof = false))
        assertTrue(transfer.accept(3, byteArrayOf(4, 5, 6), eof = true))

        assertTrue(transfer.done)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), transfer.bytes())
    }

    @Test
    fun `several asks ride at once, up to the window`() {
        // The whole point of pipelining: a round trip costs more than the bytes,
        // so the next ask must not wait for the last answer.
        val transfer = AttachmentTransfer(total = 1000)

        assertEquals(listOf(0L, 10L, 20L, 30L), transfer.askAll(slice = 10, window = 4))
        // Window full — nothing more until an answer frees a slot.
        assertNull(transfer.nextAsk(10, 4))

        transfer.accept(0, ByteArray(10), eof = false)
        assertEquals(40L, transfer.nextAsk(10, 4))
    }

    @Test
    fun `a slice that arrives ahead of the gap is held, not thrown away`() {
        // With four asks in flight the answers race. Refusing the fast one would
        // throw away a whole round trip's work.
        val transfer = AttachmentTransfer(total = 9)
        transfer.askAll(slice = 3)

        assertTrue(transfer.accept(6, byteArrayOf(7, 8, 9), eof = true))
        assertEquals(0L, transfer.received)

        transfer.accept(3, byteArrayOf(4, 5, 6), eof = false)
        assertEquals(0L, transfer.received)

        // Closing the gap folds in everything that was waiting behind it.
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)
        assertTrue(transfer.done)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9), transfer.bytes())
    }

    @Test
    fun `a repeated slice is refused rather than counted twice`() {
        val transfer = AttachmentTransfer(total = 6)
        transfer.askAll(slice = 3)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        // One ask answered twice would otherwise double the bytes and still
        // report a plausible-looking total.
        assertFalse(transfer.accept(0, byteArrayOf(1, 2, 3), eof = false))
        assertEquals(3L, transfer.received)
    }

    @Test
    fun `a slice nobody asked for is refused`() {
        val transfer = AttachmentTransfer(total = 9)
        transfer.nextAsk(3, 1)

        assertFalse(transfer.accept(99, byteArrayOf(1), eof = false))
    }

    @Test
    fun `the earliest end wins when an ask overshoots the tail`() {
        // The advertised size is metadata; the file is the authority. An ask
        // already in flight past the real tail answers empty-and-eof further
        // along, and letting that move the end would strand the transfer.
        val transfer = AttachmentTransfer(total = 12)
        transfer.askAll(slice = 3)

        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)
        transfer.accept(6, ByteArray(0), eof = true)
        transfer.accept(3, byteArrayOf(4, 5, 6), eof = true)

        assertTrue(transfer.done)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), transfer.bytes())
    }

    @Test
    fun `nothing is asked for once the end is known`() {
        val transfer = AttachmentTransfer(total = 1000)
        transfer.nextAsk(10, 4)
        transfer.accept(0, ByteArray(10), eof = true)

        assertNull(transfer.nextAsk(10, 4))
        assertTrue(transfer.done)
    }

    @Test
    fun `an unfinished transfer refuses to hand over a truncated file`() {
        val transfer = AttachmentTransfer(total = 6)
        transfer.nextAsk(3, 4)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        // Nothing downstream could tell a short file from a complete one.
        val error = runCatching { transfer.bytes() }.exceptionOrNull()
        assertTrue(error is IllegalStateException)
    }

    @Test
    fun `an empty final slice ends the transfer without adding to it`() {
        val transfer = AttachmentTransfer(total = 3)
        transfer.askAll(slice = 3)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        assertTrue(transfer.accept(3, ByteArray(0), eof = true))
        assertArrayEquals(byteArrayOf(1, 2, 3), transfer.bytes())
    }

    @Test
    fun `abandoning the asks rewinds to the gap and refuses the stragglers`() {
        val transfer = AttachmentTransfer(total = 12)
        transfer.askAll(slice = 3)
        transfer.accept(0, byteArrayOf(1, 2, 3), eof = false)

        transfer.forgetAsks()

        // A retry re-asks from what actually arrived...
        assertEquals(3L, transfer.nextAsk(3, 4))
        // ...and a late answer to the dead attempt cannot be counted.
        assertFalse(transfer.accept(6, byteArrayOf(7, 8, 9), eof = false))
    }
}

/** The repository half: what the tile shows, and what survives a stumble. */
class ChatRepositoryPullTest {
    private val chats = ChatRepository()

    private fun arriveWithFile(sizeBytes: Long = 6L): String {
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
                sizeBytes = sizeBytes,
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

    /** Drive the pipeline the way HelmClient does: ask for all it will give. */
    private fun askAll(key: String): List<Long> = generateSequence { chats.nextAsk(key) }.toList()

    @Test
    fun `a fetch reports progress and completes with the whole file`() {
        // Two full slices, so the offsets are the ones the real loop asks for.
        val slice = ATTACHMENT_SLICE_BYTES
        val key = arriveWithFile(sizeBytes = slice * 2L)
        val attachment = chats.thread("s1").last().attachment!!

        assertTrue(chats.pullStarted(key, attachment))
        askAll(key)

        assertNull(chats.sliceArrived(key, 0, ByteArray(slice) { 1 }, eof = false))
        assertEquals(PullState.Pulling(slice.toLong(), slice * 2L), chats.pullState(key))

        val whole = chats.sliceArrived(key, slice.toLong(), ByteArray(slice) { 2 }, eof = true)
        assertEquals(slice * 2, whole?.size)
        assertEquals(1.toByte(), whole?.first())
        assertEquals(2.toByte(), whole?.last())

        chats.pullSaved(key, "Downloads/holiday.jpg", "content://downloads/7")
        assertEquals(
            PullState.Ready("Downloads/holiday.jpg", "content://downloads/7"),
            chats.pullState(key),
        )
    }

    @Test
    fun `a second tap cannot start a second loop into the same buffer`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)

        assertFalse(chats.pullStarted(key, attachment))
    }

    @Test
    fun `a retry resumes from what already arrived`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        askAll(key)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        chats.pullFailed(key, "the link dropped")
        assertEquals(PullState.Failed("the link dropped"), chats.pullState(key))

        // On a slow link, restarting from zero is the difference between a lost
        // minute and a lost transfer.
        assertTrue(chats.pullStarted(key, attachment))
        assertEquals(3L, chats.nextAsk(key))
    }

    @Test
    fun `a slice nobody is waiting for is dropped, not treated as progress`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        askAll(key)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        // A duplicate answer must not advance anything — and must not fail the
        // tile either, since the transfer itself is still healthy.
        assertNull(chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false))
        assertEquals(PullState.Pulling(3, 6), chats.pullState(key))
    }

    @Test
    fun `cancelling throws the part away`() {
        val key = arriveWithFile()
        val attachment = chats.thread("s1").last().attachment!!
        chats.pullStarted(key, attachment)
        askAll(key)
        chats.sliceArrived(key, 0, byteArrayOf(1, 2, 3), eof = false)

        chats.pullCancelled(key)

        assertEquals(PullState.Idle, chats.pullState(key))
        // Nothing half-written survives: the next attempt starts clean.
        assertTrue(chats.pullStarted(key, attachment))
        assertEquals(0L, chats.nextAsk(key))
    }
}
