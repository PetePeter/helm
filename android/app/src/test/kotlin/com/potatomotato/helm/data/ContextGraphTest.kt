package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ContextGraphTest {
    private fun reply(at: Long, tokens: Long?, window: Long? = null, amber: Long? = null, red: Long? = null) =
        ChatMessage(
            key = "k$at", text = "r", at = at, fromPhone = false,
            contextTokens = tokens, contextWindow = window, contextAmber = amber, contextRed = red,
        )

    @Test
    fun sessionRowGraphUsesATwoHourRollingWindow() {
        assertEquals(2L * 60 * 60 * 1000, ContextGraph.ROW_SPAN_MS)
    }

    @Test
    fun buildsHistoryFromRepliesInTimeOrderWithTheLatestWindow() {
        val thread = listOf(
            reply(30, 300, 1000),
            ChatMessage(key = "me", text = "hi", at = 20, fromPhone = true),
            reply(10, 100, 800),
            reply(25, null),
        )
        val history = ContextGraph.fromThread(thread, now = 30)!!
        assertEquals(listOf(ContextSample(10, 100), ContextSample(30, 300)), history.samples)
        assertEquals(1000L, history.window)
    }

    @Test
    fun aThreadWithoutStatsHasNoHistory() {
        assertNull(ContextGraph.fromThread(listOf(reply(1, null))))
        assertNull(ContextGraph.fromThread(emptyList()))
    }

    @Test
    fun sessionListObservationsKeepTheirArrivalTimestampsAndServerLevels() {
        val history = ContextGraph.fromThread(
            listOf(reply(10, 1_200, 10_000)),
            SessionContext(8_500, 10_000, ContextLevel.Hot),
            observations = listOf(ContextSample(40, 8_500, ContextLevel.Hot)),
            now = 50,
        )!!

        assertEquals(
            listOf(ContextSample(10, 1_200), ContextSample(40, 8_500, ContextLevel.Hot)),
            history.samples,
        )
        assertEquals(10_000L, history.window)
        assertEquals(ContextLevel.Hot, ContextGraph.level(history.samples.last(), history.limits))
    }

    @Test
    fun sessionListObservationsCreateHistoryBeforeAnyReplyArrives() {
        val history = ContextGraph.fromThread(
            emptyList(),
            SessionContext(1_200, null, null),
            observations = listOf(ContextSample(40, 1_200)),
            now = 50,
        )!!

        assertEquals(listOf(ContextSample(40, 1_200)), history.samples)
        assertNull(history.window)
    }

    @Test
    fun historyContainsOnlyObservedSamplesWithinTheRollingTwoHourGraphWindow() {
        val now = ContextGraph.ROW_SPAN_MS + 50
        val history = ContextGraph.fromThread(
            listOf(reply(49, 490), reply(50, 500), reply(now + 1, 999)),
            latest = SessionContext(1_000, 10_000, null),
            observations = listOf(ContextSample(1, 10), ContextSample(75, 750), ContextSample(now + 1, 2_000)),
            now = now,
        )!!

        assertEquals(
            listOf(ContextSample(50, 500), ContextSample(75, 750)),
            history.samples,
        )
    }

    @Test
    fun aSingleSparklineSampleIsCenteredAtItsContextValue() {
        val point = ContextGraph.sparklinePoints(
            listOf(ContextSample(50, 25)),
            ceiling = 100f,
            width = 20f,
            height = 10f,
        ).single()

        assertEquals(10f, point.x, 0.0001f)
        assertEquals(7.5f, point.y, 0.0001f)
    }

    @Test
    fun usesTheLimitsTheDesktopSentElseFallsBackTo75And90PercentOfTheWindow() {
        assertEquals(ContextLimits(50, 80), ContextGraph.fromThread(listOf(reply(1, 10, 1000, 50, 80), reply(2, 20, 1000)), now = 2)!!.limits)
        assertEquals(ContextLimits(750, 900), ContextGraph.fromThread(listOf(reply(1, 10, 1000)), now = 1)!!.limits)
        assertNull(ContextGraph.fromThread(listOf(reply(1, 10)), now = 1)!!.limits)
    }

    @Test
    fun levelTurnsAmberAboveAmberAndRedAboveRed() {
        val limits = ContextLimits(75, 90)
        assertEquals(ContextLevel.Ok, ContextGraph.level(75, limits))
        assertEquals(ContextLevel.Warn, ContextGraph.level(76, limits))
        assertEquals(ContextLevel.Warn, ContextGraph.level(90, limits))
        assertEquals(ContextLevel.Hot, ContextGraph.level(91, limits))
        assertEquals(ContextLevel.Ok, ContextGraph.level(1_000_000, null))
    }

    @Test
    fun `the header bar fills against the window, else the red limit, else not at all`() {
        val now = listOf(ContextSample(0, 250_000))
        assertEquals(0.25f, ContextGraph.fill(ContextHistory(now, 1_000_000, ContextLimits(1, 2)))!!, 0.0001f)
        assertEquals(0.5f, ContextGraph.fill(ContextHistory(now, null, ContextLimits(400_000, 500_000)))!!, 0.0001f)
        assertNull(ContextGraph.fill(ContextHistory(now, null, null)))
        assertEquals(1f, ContextGraph.fill(ContextHistory(listOf(ContextSample(0, 9_000)), 1_000, null))!!, 0.0001f)
    }
}
