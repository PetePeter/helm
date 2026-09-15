package com.potatomotato.helm.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    /** The desktop's exact key order for an artifact push, from mobile-chat-bridge.ts. */
    private fun artifactChat(): ByteArray =
        ("""{"v":1,"t":"chat","sessionId":"s1","sessionName":"work","text":"Perf report","at":1700000000000,""" +
            """"artifactId":"a9f1","title":"Perf report","kind":"artifact"}""")
            .toByteArray(Charsets.UTF_8)
}
