package com.potatomotato.helm.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The false-wake guard: a background mic that wakes on TV is worse than none. */
class WakeDetectorTest {
    private val detector = WakeDetector(minConfidence = 0.75, cooldownMs = 2_000)

    private fun result(text: String, vararg confs: Double): String {
        val words = text.split(" ").filter { it.isNotEmpty() }.mapIndexed { i, w ->
            """{"conf":${confs.getOrElse(i) { 1.0 }},"start":0.0,"end":0.5,"word":"$w"}"""
        }
        return """{"result":[${words.joinToString(",")}],"text":"$text"}"""
    }

    @Test
    fun `a confident hey helm wakes`() {
        assertTrue(detector.accept(result("hey helm", 0.98, 0.91), nowMs = 0))
    }

    @Test
    fun `unknown speech and empty results never wake`() {
        assertFalse(detector.accept(result("[unk]"), nowMs = 0))
        assertFalse(detector.accept("""{"text":""}""", nowMs = 0))
        assertFalse(detector.accept(result("hey helm [unk]"), nowMs = 0))
    }

    @Test
    fun `a low-confidence word does not wake`() {
        assertFalse(detector.accept(result("hey helm", 0.99, 0.4), nowMs = 0))
    }

    @Test
    fun `text without word confidences does not wake`() {
        assertFalse(detector.accept("""{"text":"hey helm"}""", nowMs = 0))
    }

    @Test
    fun `malformed json does not wake`() {
        assertFalse(detector.accept("not json", nowMs = 0))
    }

    @Test
    fun `a second detection inside the cooldown is ignored, after it wakes again`() {
        assertTrue(detector.accept(result("hey helm"), nowMs = 0))
        assertFalse(detector.accept(result("hey helm"), nowMs = 1_500))
        assertTrue(detector.accept(result("hey helm"), nowMs = 2_500))
    }
}
