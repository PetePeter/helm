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
    fun buildsHistoryFromRepliesInTimeOrderWithTheLatestWindow() {
        val thread = listOf(
            reply(30, 300, 1000),
            ChatMessage(key = "me", text = "hi", at = 20, fromPhone = true),
            reply(10, 100, 800),
            reply(25, null),
        )
        val history = ContextGraph.fromThread(thread)!!
        assertEquals(listOf(ContextSample(10, 100), ContextSample(30, 300)), history.samples)
        assertEquals(1000L, history.window)
    }

    @Test
    fun aThreadWithoutStatsHasNoHistory() {
        assertNull(ContextGraph.fromThread(listOf(reply(1, null))))
        assertNull(ContextGraph.fromThread(emptyList()))
    }

    @Test
    fun aSessionRowContextIsTheLatestSampleAndCarriesItsServerLevel() {
        val history = ContextGraph.fromThread(
            listOf(reply(10, 1_200, 10_000)),
            SessionContext(8_500, 10_000, ContextLevel.Hot),
            now = 50,
        )!!

        assertEquals(
            listOf(ContextSample(10, 1_200), ContextSample(50, 8_500, ContextLevel.Hot)),
            history.samples,
        )
        assertEquals(10_000L, history.window)
        assertEquals(ContextLevel.Hot, ContextGraph.level(history.samples.last(), history.limits))
    }

    @Test
    fun aSessionRowContextCanCreateHistoryBeforeAnyReplyArrives() {
        val history = ContextGraph.fromThread(emptyList(), SessionContext(1_200, null, null), now = 50)!!

        assertEquals(listOf(ContextSample(50, 1_200)), history.samples)
        assertNull(history.window)
    }

    @Test
    fun windowCarriesTheEarlierLevelInAndTheLatestOutToNow() {
        val samples = listOf(ContextSample(0, 10), ContextSample(50, 20), ContextSample(80, 30))
        assertEquals(
            listOf(ContextSample(40, 10), ContextSample(50, 20), ContextSample(80, 30), ContextSample(100, 30)),
            ContextGraph.window(samples, from = 40, to = 100),
        )
        assertEquals(listOf(ContextSample(40, 7), ContextSample(100, 7)), ContextGraph.window(listOf(ContextSample(0, 7)), 40, 100))
        assertEquals(emptyList<ContextSample>(), ContextGraph.window(listOf(ContextSample(120, 7)), 40, 100))
    }

    @Test
    fun usesTheLimitsTheDesktopSentElseFallsBackTo75And90PercentOfTheWindow() {
        assertEquals(ContextLimits(50, 80), ContextGraph.fromThread(listOf(reply(1, 10, 1000, 50, 80), reply(2, 20, 1000)))!!.limits)
        assertEquals(ContextLimits(750, 900), ContextGraph.fromThread(listOf(reply(1, 10, 1000)))!!.limits)
        assertNull(ContextGraph.fromThread(listOf(reply(1, 10)))!!.limits)
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
}
