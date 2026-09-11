package com.potatomotato.helm.wire

import com.potatomotato.helm.fromHex
import com.potatomotato.helm.loadFixture
import com.potatomotato.helm.toHex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The application records, pinned to the desktop's committed vectors.
 *
 * Framing and the handshake already agree byte for byte; this is the last layer
 * where the two languages must read each other, and like the others it fails
 * silently when it drifts — a mistyped key name is an app that connects, says
 * nothing and never explains why. So nothing here is hand-copied: every expected
 * byte comes from `tests/fixtures/mobile-envelope-vectors.json`, read in place.
 *
 * Both directions are covered. The phone only ENCODES calls (every inbound
 * record is one, by the gate's design), so encode conformance is asserted on the
 * phone-to-helm cases and decode conformance on all of them.
 */
class MobileEnvelopeVectorsTest {
    private val vectors: JSONObject = loadFixture("mobile-envelope-vectors.json")

    @Test
    fun `constants match the desktop format header`() {
        val format = vectors.getJSONObject("format")
        assertEquals(format.getInt("version"), MobileEnvelope.VERSION)
        assertEquals(format.getInt("maxEnvelopeBytes"), MobileEnvelope.MAX_ENVELOPE_BYTES)
    }

    @Test
    fun `every vector decodes to the record the desktop meant`() {
        forEachCase { name, direction, bytes, json ->
            val record = MobileEnvelope.decode(bytes)
                ?: throw AssertionError("$name ($direction): must decode")

            // The vector carries the canonical JSON alongside the bytes; re-reading
            // the decoded record against it proves the FIELDS were understood, not
            // merely that the payload parsed.
            val expected = JSONObject(json)
            when (record) {
                is MobileRecord.Call -> {
                    assertEquals(name, expected.getString("id"), record.id)
                    assertEquals(name, expected.getString("method"), record.method)
                }

                is MobileRecord.Result -> {
                    assertEquals(name, expected.getString("id"), record.id)
                    assertEquals(name, expected.isNull("result"), record.result == null)
                }

                is MobileRecord.Failure -> {
                    val error = expected.getJSONObject("error")
                    assertEquals(name, expected.getString("id"), record.id)
                    assertEquals(name, error.getInt("code"), record.code)
                    assertEquals(name, error.getString("message"), record.message)
                }

                is MobileRecord.Chat -> {
                    assertEquals(name, expected.getString("sessionId"), record.sessionId)
                    assertEquals(name, expected.getString("sessionName"), record.sessionName)
                    assertEquals(name, expected.getString("text"), record.text)
                    assertEquals(name, expected.getLong("at"), record.at)
                    val filePath = if (expected.has("filePath")) expected.getString("filePath") else null
                    assertEquals(name, filePath, record.filePath)
                    assertEquals(name, expected.optBoolean("voice", false), record.voice)
                }
            }
        }
    }

    @Test
    fun `the phone re-encodes every call vector byte for byte`() {
        var calls = 0
        forEachCase { name, direction, bytes, json ->
            if (direction != "phone-to-helm") return@forEachCase
            calls++

            val source = JSONObject(json)
            val params = if (source.has("params")) {
                val raw = source.getJSONObject("params")
                // Key ORDER is the whole point, and org.json does not preserve it —
                // take the order from the canonical JSON text itself.
                orderedKeys(json).associateWithTo(LinkedHashMap()) { raw.getString(it) }
            } else {
                null
            }

            val produced = MobileEnvelope.encodeCall(
                id = source.getString("id"),
                method = source.getString("method"),
                params = params,
            )
            assertEquals(name, bytes.toHex(), produced.toHex())
        }
        assertTrue("the fixture must carry phone-to-helm calls", calls > 0)
    }

    @Test
    fun `every reject vector decodes to nothing`() {
        val rejects = vectors.getJSONArray("rejects")
        assertTrue("the fixture must carry reject cases", rejects.length() > 0)

        for (i in 0 until rejects.length()) {
            val case = rejects.getJSONObject(i)
            assertNull(
                "${case.getString("name")}: ${case.getString("reason")}",
                MobileEnvelope.decode(case.getString("bytesHex").fromHex()),
            )
        }
    }

    @Test
    fun `an envelope past the cap is refused before it is parsed`() {
        val huge = ByteArray(MobileEnvelope.MAX_ENVELOPE_BYTES + 1) { '{'.code.toByte() }
        assertNull(MobileEnvelope.decode(huge))
        assertNull(MobileEnvelope.decode(ByteArray(0)))
    }

    /** Param keys in the order the canonical JSON text writes them. */
    private fun orderedKeys(json: String): List<String> {
        val params = json.substringAfter("\"params\":{").substringBeforeLast("}")
        return Regex("\"([^\"]+)\":").findAll(params).map { it.groupValues[1] }.toList()
    }

    private fun forEachCase(body: (name: String, direction: String, bytes: ByteArray, json: String) -> Unit) {
        val cases = vectors.getJSONArray("cases")
        assertTrue("the fixture must carry cases", cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            body(
                case.getString("name"),
                case.getString("direction"),
                case.getString("bytesHex").fromHex(),
                case.getString("json"),
            )
        }
    }
}
