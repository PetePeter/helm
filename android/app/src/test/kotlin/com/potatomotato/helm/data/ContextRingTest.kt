package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Cross-language vectors: tests/session/context-limits.test.ts asserts the same
 * rows, so the phone and the desktop never draw a different ring for one reading.
 */
class ContextRingTest {
    private class Vector(
        val name: String,
        val tokens: Long,
        val limits: ContextLimits,
        val fill: Float,
        val amberAt: Float,
        val level: ContextLevel,
        val overflow: Boolean,
    )

    private val auto = ContextLimits(amber = 150_000, red = 180_000)
    private val user = ContextLimits(amber = 120_000, red = 160_000)

    private val vectors = listOf(
        Vector("empty", 0, auto, 0f, 0.75f, ContextLevel.Ok, false),
        Vector("half of an auto window", 100_000, auto, 0.5f, 0.75f, ContextLevel.Ok, false),
        Vector("exactly amber is still ok", 150_000, auto, 0.75f, 0.75f, ContextLevel.Ok, false),
        Vector("past amber", 150_001, auto, 0.75f, 0.75f, ContextLevel.Warn, false),
        Vector("past red", 180_001, auto, 0.9f, 0.75f, ContextLevel.Hot, false),
        Vector("exactly the window is full, not overflowing", 200_000, auto, 1f, 0.75f, ContextLevel.Hot, false),
        Vector("beyond the window overflows", 230_000, auto, 1f, 0.75f, ContextLevel.Hot, true),
        Vector("user limit puts red at 90% of the circle", 160_000, user, 0.9f, 0.675f, ContextLevel.Warn, false),
        Vector("user limit overflows past the circle", 200_000, user, 1f, 0.675f, ContextLevel.Hot, true),
    )

    @Test
    fun ringMatchesTheSharedVectors() {
        for (v in vectors) {
            val ring = ContextGraph.ring(v.tokens, v.limits)!!
            assertEquals(v.name, v.fill, ring.fill, 1e-4f)
            assertEquals(v.name, v.amberAt, ring.amberAt, 1e-4f)
            assertEquals(v.name, ContextGraph.RING_RED_AT, ring.redAt, 0f)
            assertEquals(v.name, v.level, ring.level)
            assertEquals(v.name, v.overflow, ring.overflow)
        }
    }

    @Test
    fun noRingWithoutLimitsSoTheCallerDrawsAPlainDot() {
        assertNull(ContextGraph.ring(50_000, null))
    }

    @Test
    fun summaryNamesTokensWindowAndPercent() {
        val history = ContextHistory(listOf(ContextSample(1, 152_000)), window = 200_000, limits = null)
        assertEquals("152k / 200k · 76%", ContextGraph.summary(history))
    }

    @Test
    fun summaryWithoutAWindowIsJustTheTokens() {
        assertEquals("152k", ContextGraph.summary(ContextHistory(listOf(ContextSample(1, 152_000)), null, null)))
        assertEquals("900", ContextGraph.summary(ContextHistory(listOf(ContextSample(1, 900)), null, null)))
    }

    @Test
    fun graphCeilingIsTheRedLimitPlusARoomMarginNotTheWholeWindow() {
        val low = listOf(ContextSample(1, 50_000), ContextSample(2, 100_000))
        assertEquals(198_000L, ContextGraph.ceiling(low, ContextLimits(150_000, 180_000), 200_000))
    }

    @Test
    fun graphCeilingGrowsWithAPeakPastRedButNeverPastTheWindow() {
        val high = listOf(ContextSample(1, 50_000), ContextSample(2, 190_000))
        assertEquals(200_000L, ContextGraph.ceiling(high, ContextLimits(150_000, 180_000), 200_000))
        assertEquals(209_000L, ContextGraph.ceiling(high, ContextLimits(150_000, 180_000), null))
    }

    @Test
    fun graphCeilingFallsBackToThePeakWithNothingElseKnown() {
        assertEquals(100_000L, ContextGraph.ceiling(listOf(ContextSample(1, 100_000)), null, null))
    }
}
