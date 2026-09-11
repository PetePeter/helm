package com.potatomotato.helm.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * Behaviour the fixture cannot express: loss, interleaving and resynchronisation
 * are properties of a live reassembler over time, not of a single message.
 */
class BleFramingTest {
    private val received = mutableListOf<ByteArray>()
    private val drops = mutableListOf<String>()
    private val reassembler = BleReassembler({ received.add(it) }, { drops.add(it) })

    @Test
    fun `round-trips payloads above and below the MTU`() {
        val chunker = BleChunker()
        val small = Random(1).nextBytes(7)
        val large = Random(2).nextBytes(4_001)

        chunker.chunk(small, 20).forEach(reassembler::push)
        chunker.chunk(large, 20).forEach(reassembler::push)

        assertEquals(emptyList<String>(), drops)
        assertEquals(listOf(small.toHex(), large.toHex()), received.map { it.toHex() })
    }

    @Test
    fun `a dropped middle chunk is detected, not silently concatenated`() {
        val message = Random(3).nextBytes(120)
        val chunks = BleChunker().chunk(message, 20)
        assertTrue("needs at least three chunks to lose a middle one", chunks.size >= 3)

        chunks.filterIndexed { i, _ -> i != 1 }.forEach(reassembler::push)

        assertEquals(emptyList<String>(), received.map { it.toHex() })
        assertTrue(drops.any { it.contains("sequence gap") })
    }

    @Test
    fun `the reassembler resynchronises on the next message after a loss`() {
        val lost = BleChunker().chunk(Random(4).nextBytes(120), 20)
        lost.filterIndexed { i, _ -> i != 1 }.forEach(reassembler::push)

        // A fresh link, hence a fresh chunker: the next message must arrive whole.
        val good = Random(5).nextBytes(30)
        BleChunker(lost.size).chunk(good, 20).forEach(reassembler::push)

        assertEquals(listOf(good.toHex()), received.map { it.toHex() })
    }

    @Test
    fun `a restarted message does not cross-contaminate the next one`() {
        val abandoned = BleChunker().chunk(Random(6).nextBytes(60), 20)
        reassembler.push(abandoned[0])

        // The peer gives up and starts a new message on the next sequence number,
        // so this is a restart rather than a gap.
        val fresh = Random(7).nextBytes(9)
        BleChunker(1).chunk(fresh, 20).forEach(reassembler::push)

        assertEquals(listOf(fresh.toHex()), received.map { it.toHex() })
        assertTrue(drops.any { it.contains("restart") })
    }

    @Test
    fun `the chunker refuses a message above the cap rather than allocating`() {
        val chunker = BleChunker()
        val error = runCatching { chunker.chunk(ByteArray(BleFraming.MAX_MESSAGE_BYTES + 1), 20) }
            .exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun `the chunker refuses a chunk size that cannot carry a first-chunk header`() {
        val error = runCatching { BleChunker().chunk(ByteArray(4), BleFraming.CHUNK_OVERHEAD_FIRST) }
            .exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun `an MTU change mid-link is honoured per call`() {
        val chunker = BleChunker()
        val message = Random(8).nextBytes(400)

        val atDefaultMtu = chunker.chunk(message, BleFraming.chunkSizeForMtu(23))
        val atLargeMtu = chunker.chunk(message, BleFraming.chunkSizeForMtu(517))

        assertTrue(atLargeMtu.size < atDefaultMtu.size)
        // The sequence counter keeps running across the change.
        assertEquals(atDefaultMtu.size, atLargeMtu[0][0].toInt() and 0xff)
    }

    @Test
    fun `a negotiated MTU never falls below the BLE 4-0 floor`() {
        assertEquals(BleFraming.MIN_CHUNK_BYTES, BleFraming.chunkSizeForMtu(23))
        assertEquals(BleFraming.MIN_CHUNK_BYTES, BleFraming.chunkSizeForMtu(10))
        assertEquals(182, BleFraming.chunkSizeForMtu(185))
    }
}
