package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The GENERALIZED driver — the one a chat tile and an artifact attachment row now
 * share.
 *
 * The bug behind it: the artifact screen fetched an attachment in a single
 * unsliced call, and the desktop answers such a call with ONE slice. Every
 * multi-slice file was therefore saved truncated and opened corrupt. These tests
 * pin the two halves of the fix — that a transfer of N slices reproduces the
 * source byte for byte, and that a file bigger than one slice is asked for more
 * than once.
 */
class AttachmentPullsTest {
    private val pulls = AttachmentPulls()
    private val key = artifactAttachmentKey("art-1", "att-1")

    /** Drive the pipeline the way HelmClient does: ask for all it will give. */
    private fun askAll(slice: Int): List<Long> =
        generateSequence { pulls.nextAsk(key, slice) }.toList()

    /**
     * Feed a whole file through in slices, answering every ask, and hand back what
     * the driver says the file is. [order] reshuffles the answers.
     */
    private fun transferWhole(
        source: ByteArray,
        slice: Int,
        order: (List<Long>) -> List<Long> = { it },
    ): ByteArray? {
        pulls.pullStarted(key, source.size.toLong())
        var whole: ByteArray? = null
        while (whole == null) {
            val asks = askAll(slice)
            if (asks.isEmpty()) break
            for (offset in order(asks)) {
                val from = offset.toInt()
                val to = minOf(from + slice, source.size)
                val bytes = if (from >= to) ByteArray(0) else source.copyOfRange(from, to)
                val answer = pulls.sliceArrived(key, offset, bytes, eof = to >= source.size)
                if (answer != null) whole = answer
            }
        }
        return whole
    }

    private fun source(size: Int): ByteArray = ByteArray(size) { (it % 251).toByte() }

    @Test
    fun `a file taken in slices is the file, byte for byte`() {
        val source = source(1000)

        val whole = transferWhole(source, slice = 100)

        // Not a size check: a truncation that happens to end on a slice boundary
        // has the right length prefix and the wrong content.
        assertTrue(source.contentEquals(whole))
    }

    @Test
    fun `a file larger than one slice is asked for in several slices`() {
        // THE REGRESSION. One ask answers one slice, so one ask is one slice of
        // file — the artifact screen used to make exactly one and save the result.
        pulls.pullStarted(key, 1000L)

        val asks = askAll(slice = 100)

        assertTrue("a multi-slice file must take more than one ask", asks.size > 1)
        assertEquals(listOf(0L, 100L, 200L, 300L), asks.take(4))
    }

    @Test
    fun `answers that arrive out of order still assemble the file`() {
        val source = source(400)

        // The pipeline keeps several asks in flight, so the answers race: the
        // last one issued can be the first one back.
        val whole = transferWhole(source, slice = 100, order = { it.reversed() })

        assertTrue(source.contentEquals(whole))
    }

    @Test
    fun `a duplicate answer is dropped rather than appended twice`() {
        pulls.pullStarted(key, 300L)
        askAll(slice = 100)

        pulls.sliceArrived(key, 0, ByteArray(100), eof = false)
        // The link answering a retry twice must not count the bytes twice — that
        // is how a file ends up the right length and the wrong content.
        assertNull(pulls.sliceArrived(key, 0, ByteArray(100), eof = false))

        assertEquals(PullState.Pulling(100, 300), pulls.pullState(key))
    }

    @Test
    fun `a failure resumes at the gap, not from zero`() {
        pulls.pullStarted(key, 300L)
        askAll(slice = 100)
        pulls.sliceArrived(key, 0, ByteArray(100) { 1 }, eof = false)

        pulls.pullFailed(key, "the link dropped")
        assertEquals(PullState.Failed("the link dropped"), pulls.pullState(key))

        assertTrue(pulls.pullStarted(key, 300L))
        // On a slow link, restarting from zero is the difference between a lost
        // minute and a lost transfer.
        assertEquals(100L, pulls.nextAsk(key, 100))
    }

    @Test
    fun `a resumed transfer still produces the whole file`() {
        val source = source(300)
        pulls.pullStarted(key, 300L)
        askAll(slice = 100)
        pulls.sliceArrived(key, 0, source.copyOfRange(0, 100), eof = false)
        pulls.pullFailed(key, "the link dropped")

        pulls.pullStarted(key, 300L)
        var whole: ByteArray? = null
        for (offset in askAll(slice = 100)) {
            val from = offset.toInt()
            val to = minOf(from + 100, source.size)
            whole = pulls.sliceArrived(key, offset, source.copyOfRange(from, to), eof = to >= source.size)
                ?: whole
        }

        assertTrue(source.contentEquals(whole))
    }

    @Test
    fun `two rows pull at once without touching each other's bytes`() {
        val other = artifactAttachmentKey("art-1", "att-2")
        pulls.pullStarted(key, 200L)
        pulls.pullStarted(other, 200L)
        askAll(slice = 100)
        generateSequence { pulls.nextAsk(other, 100) }.toList()

        pulls.sliceArrived(key, 0, ByteArray(100) { 1 }, eof = false)

        assertEquals(PullState.Pulling(100, 200), pulls.pullState(key))
        assertEquals(PullState.Pulling(0, 200), pulls.pullState(other))
    }

    @Test
    fun `a second tap cannot start a second loop into the same buffer`() {
        assertTrue(pulls.pullStarted(key, 300L))

        assertFalse(pulls.pullStarted(key, 300L))
    }

    @Test
    fun `a saved transfer forgets its part-file`() {
        pulls.pullStarted(key, 300L)
        askAll(slice = 100)
        pulls.sliceArrived(key, 0, ByteArray(100), eof = false)

        pulls.pullSaved(key, "Downloads/Helm/chart.png", "content://downloads/7")

        assertEquals(PullState.Ready("Downloads/Helm/chart.png", "content://downloads/7"), pulls.pullState(key))
        // A fresh ask starts clean: the bytes are on the phone now.
        assertTrue(pulls.pullStarted(key, 300L))
        assertEquals(0L, pulls.nextAsk(key, 100))
    }

    @Test
    fun `an artifact attachment key names both ids`() {
        // The same attachment id is only unique within its artifact, and the
        // screen holds rows from more than one artifact over its life.
        assertFalse(artifactAttachmentKey("art-1", "att-1") == artifactAttachmentKey("art-2", "att-1"))
    }
}
