package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ContextGraphTest {
    private fun reply(at: Long, tokens: Long?, window: Long? = null) =
        ChatMessage(key = "k$at", text = "r", at = at, fromPhone = false, contextTokens = tokens, contextWindow = window)

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
    fun levelTurnsAmberAbove70AndRedAbove85Percent() {
        assertEquals(ContextLevel.Ok, ContextGraph.level(70, 100))
        assertEquals(ContextLevel.Warn, ContextGraph.level(71, 100))
        assertEquals(ContextLevel.Hot, ContextGraph.level(86, 100))
        assertEquals(ContextLevel.Ok, ContextGraph.level(99, null))
    }
}
