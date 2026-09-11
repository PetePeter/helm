package com.potatomotato.helm.ble

import com.potatomotato.helm.fromHex
import com.potatomotato.helm.loadFixture
import com.potatomotato.helm.toHex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The test that actually prevents cross-language drift.
 *
 * Framing is the one place where Kotlin and TypeScript must agree byte for
 * byte, and a mismatch does NOT fail loudly — it fails as "pairing just never
 * works". So the expected bytes are never hand-copied here: they are read from
 * the committed vectors emitted by the desktop side (P-0734). Regenerating that
 * file is a wire break.
 */
class BleFramingVectorsTest {
    private val vectors: JSONObject = loadVectors()

    @Test
    fun `constants match the desktop format header`() {
        val format = vectors.getJSONObject("format")
        assertEquals(format.getInt("chunkHeaderBytes"), BleFraming.CHUNK_HEADER_BYTES)
        assertEquals(format.getInt("lengthPrefixBytes"), BleFraming.LENGTH_PREFIX_BYTES)
        assertEquals(format.getInt("chunkOverheadFirst"), BleFraming.CHUNK_OVERHEAD_FIRST)
        assertEquals(format.getInt("minChunkBytes"), BleFraming.MIN_CHUNK_BYTES)
        assertEquals(format.getInt("maxMessageBytes"), BleFraming.MAX_MESSAGE_BYTES)
        assertEquals(format.getInt("flagFirst"), BleFraming.FLAG_FIRST)
        assertEquals(format.getInt("flagLast"), BleFraming.FLAG_LAST)
    }

    @Test
    fun `chunker reproduces every vector byte for byte`() {
        forEachCase { name, initialSeq, chunkSize, message, expected ->
            val produced = BleChunker(initialSeq).chunk(message, chunkSize)
            assertEquals("$name: chunk count", expected.size, produced.size)
            expected.forEachIndexed { i, want ->
                assertEquals("$name: chunk $i", want.toHex(), produced[i].toHex())
            }
        }
    }

    @Test
    fun `reassembler rebuilds the original message from every vector`() {
        forEachCase { name, _, _, message, chunks ->
            val received = mutableListOf<ByteArray>()
            val drops = mutableListOf<String>()
            val reassembler = BleReassembler({ received.add(it) }, { drops.add(it) })
            chunks.forEach(reassembler::push)

            assertEquals("$name: drops $drops", 0, drops.size)
            assertEquals("$name: message count", 1, received.size)
            assertEquals("$name: payload", message.toHex(), received[0].toHex())
        }
    }

    @Test
    fun `every reject vector is refused and delivers nothing`() {
        val rejects = vectors.getJSONArray("rejects")
        assertTrue("the fixture must carry reject cases", rejects.length() > 0)

        for (i in 0 until rejects.length()) {
            val case = rejects.getJSONObject(i)
            val name = case.getString("name")
            val received = mutableListOf<ByteArray>()
            val drops = mutableListOf<String>()
            val reassembler = BleReassembler({ received.add(it) }, { drops.add(it) })

            case.getJSONArray("chunksHex").let { hexes ->
                for (j in 0 until hexes.length()) reassembler.push(hexes.getString(j).fromHex())
            }

            assertEquals("$name: must deliver no message", 0, received.size)
            assertTrue("$name: must report a drop", drops.isNotEmpty())
        }
    }

    @Test
    fun `an oversized declared length is refused before anything is buffered`() {
        val drops = mutableListOf<String>()
        val reassembler = BleReassembler({ throw AssertionError("must not deliver") }, { drops.add(it) })

        // Declares 1 GiB and carries four bytes.
        reassembler.push("00034000000000000000".fromHex())

        assertEquals(0, reassembler.bufferedBytes)
        assertTrue(drops.single().contains("exceeds"))
    }

    private fun forEachCase(
        body: (name: String, initialSeq: Int, chunkSize: Int, message: ByteArray, chunks: List<ByteArray>) -> Unit,
    ) {
        val cases = vectors.getJSONArray("cases")
        assertTrue("the fixture must carry cases", cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val hexes = case.getJSONArray("chunksHex")
            val chunks = (0 until hexes.length()).map { hexes.getString(it).fromHex() }
            body(
                case.getString("name"),
                case.getInt("initialSeq"),
                case.getInt("chunkSize"),
                case.getString("messageHex").fromHex(),
                chunks,
            )
        }
    }

    private fun loadVectors(): JSONObject = loadFixture("ble-framing-vectors.json")
}
