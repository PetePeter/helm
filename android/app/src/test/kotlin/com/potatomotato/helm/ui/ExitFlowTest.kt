package com.potatomotato.helm.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The quit half of the exit dialog.
 *
 * The order IS the contract: LAN's non-daemon pump thread holds the process
 * alive past finish(), so it stops first; the service stops before the
 * activity goes away. And finish() runs even when a stop throws — a quit that
 * stops halfway leaves the notification and the link running with no UI left
 * to stop them from.
 */
class ExitFlowTest {

    @Test
    fun `quit stops lan, then the service, then finishes`() {
        val calls = mutableListOf<String>()
        quitHelmApp(
            stopLan = { calls += "lan" },
            stopLinkService = { calls += "service" },
            finish = { calls += "finish" },
        )
        assertEquals(listOf("lan", "service", "finish"), calls)
    }

    @Test
    fun `a throwing lan stop does not stop the rest`() {
        val calls = mutableListOf<String>()
        quitHelmApp(
            stopLan = { throw IllegalStateException("lan") },
            stopLinkService = { calls += "service" },
            finish = { calls += "finish" },
        )
        assertEquals(listOf("service", "finish"), calls)
    }

    @Test
    fun `a throwing service stop still finishes`() {
        var finished = false
        quitHelmApp(
            stopLan = { },
            stopLinkService = { throw IllegalStateException("service") },
            finish = { finished = true },
        )
        assertTrue(finished)
    }

    @Test
    fun `finish runs exactly once when every stop throws`() {
        var finishCount = 0
        quitHelmApp(
            stopLan = { throw IllegalStateException("lan") },
            stopLinkService = { throw IllegalStateException("service") },
            finish = { finishCount++ },
        )
        assertEquals(1, finishCount)
    }
}
