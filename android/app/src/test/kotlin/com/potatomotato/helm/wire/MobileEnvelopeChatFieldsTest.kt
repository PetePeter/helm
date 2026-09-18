package com.potatomotato.helm.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The artifact keys on a chat record: `artifactId` and `title`.
 *
 * The desktop emits them additively — `mobile-envelope.ts` appends them before
 * `kind` and omits them entirely when absent — and no vector was regenerated for
 * them, so the Kotlin side must decode them by KEY NAME from the encoder's key
 * order: filePath, voice, artifactId, title, kind. These tests build the exact
 * bytes the desktop sends and assert the decode, including the fact that the
 * fields are OPTIONAL: every record the phone received before artifacts learned
 * to push must decode exactly as it did before.
 */
class MobileEnvelopeChatFieldsTest {

    @Test
    fun `an artifact record decodes its id and title`() {
        val record = MobileEnvelope.decode(artifactChat()) as MobileRecord.Chat

        assertEquals("a9f1", record.artifactId)
        assertEquals("Perf report", record.title)
        assertEquals("artifact", record.kind)
        assertEquals("Perf report", record.text)
        assertEquals("s1", record.sessionId)
    }

    @Test
    fun `a record without the artifact keys decodes as before`() {
        val record = MobileEnvelope.decode(
            """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"hello","at":5}"""
                .toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.artifactId)
        assertNull(record.title)
        assertNull(record.kind)
    }

    @Test
    fun `an artifactId without a kind still decodes`() {
        // Decoding is tolerant and additive; what a kindless artifactId MEANS is
        // routing's business, not the codec's.
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"artifactId":"a1","title":"T"}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertEquals("a1", record.artifactId)
        assertEquals("T", record.title)
        assertNull(record.kind)
    }

    @Test
    fun `a non-string artifactId is dropped rather than coerced`() {
        // Same rule as `kind`: optString would turn a numeric id into a plausible
        // "7" and key a notification row on the strength of a bug.
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"artifactId":7,"title":"T"}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.artifactId)
    }

    @Test
    fun `a numeric title is dropped rather than coerced`() {
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"title":42}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.title)
    }

    @Test
    fun `a journaled message decodes the seq it is caught up from`() {
        // The desktop emits seq LAST, after sizeBytes; the key order here is
        // byte-for-byte what mobile-chat-bridge.ts produces for a replayed record.
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"seq":42}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertEquals(42L, record.seq)
    }

    @Test
    fun `a record without a seq decodes as before, so an old desktop degrades safely`() {
        val record = MobileEnvelope.decode(
            """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"hello","at":5}"""
                .toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.seq)
    }

    @Test
    fun `an echoed phone reply decodes its origin id and replay flag`() {
        // The desktop emits them after `seq`, last of all; key order is byte-for-byte
        // what mobile-chat-bridge.ts produces for a replayed phone-origin echo.
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"seq":3,"originId":"phone-machine:p2","replay":true}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertEquals("phone-machine:p2", record.originId)
        assertTrue(record.replay)
        assertEquals(3L, record.seq)
    }

    @Test
    fun `a live record decodes with no origin id and replay false`() {
        val record = MobileEnvelope.decode(
            """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"hello","at":5}"""
                .toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.originId)
        assertFalse(record.replay)
    }

    @Test
    fun `a non-string originId is dropped rather than coerced`() {
        val record = MobileEnvelope.decode(
            (
                """{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"x","at":5,""" +
                    """"originId":7}"""
                ).toByteArray(Charsets.UTF_8),
        ) as MobileRecord.Chat

        assertNull(record.originId)
    }

    /** The desktop's exact key order for an artifact push, from mobile-chat-bridge.ts. */
    private fun artifactChat(): ByteArray =
        ("""{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"Perf report","at":1700000000000,""" +
            """"artifactId":"a9f1","title":"Perf report","kind":"artifact"}""")
            .toByteArray(Charsets.UTF_8)
}
