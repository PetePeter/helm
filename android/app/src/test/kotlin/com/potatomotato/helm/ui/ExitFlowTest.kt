package com.potatomotato.helm.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The quit half of the exit dialog.
 *
 * The order IS the contract: LAN's non-daemon pump thread holds the process
 * alive past finish(), so it stops first; the service stops before the
 * activity goes away, and the process ends last — a finished activity leaves a
 * live process whose in-memory state comes back when Recents reopens it. And
 * finish() and the process end run even when a stop throws — a quit that stops
 * halfway leaves the notification and the link running with no UI left to stop
 * them from.
 */
class ExitFlowTest {

    @Test
    fun `quit stops lan, then the service, then finishes, then ends the process`() {
        val calls = mutableListOf<String>()
        quitHelmApp(
            stopLan = { calls += "lan" },
            stopLinkService = { calls += "service" },
            finish = { calls += "finish" },
            endProcess = { calls += "end" },
        )
        assertEquals(listOf("lan", "service", "finish", "end"), calls)
    }

    @Test
    fun `a throwing lan stop does not stop the rest`() {
        val calls = mutableListOf<String>()
        quitHelmApp(
            stopLan = { throw IllegalStateException("lan") },
            stopLinkService = { calls += "service" },
            finish = { calls += "finish" },
            endProcess = { calls += "end" },
        )
        assertEquals(listOf("service", "finish", "end"), calls)
    }

    @Test
    fun `a throwing service stop still finishes`() {
        var finished = false
        quitHelmApp(
            stopLan = { },
            stopLinkService = { throw IllegalStateException("service") },
            finish = { finished = true },
            endProcess = { },
        )
        assertTrue(finished)
    }

    @Test
    fun `finish and process end run exactly once when every stop throws`() {
        val calls = mutableListOf<String>()
        quitHelmApp(
            stopLan = { throw IllegalStateException("lan") },
            stopLinkService = { throw IllegalStateException("service") },
            finish = { calls += "finish" },
            endProcess = { calls += "end" },
        )
        assertEquals(listOf("finish", "end"), calls)
    }

    @Test
    fun `a throwing finish still ends the process`() {
        var ended = false
        try {
            quitHelmApp(
                stopLan = { },
                stopLinkService = { },
                finish = { throw IllegalStateException("finish") },
                endProcess = { ended = true },
            )
        } catch (_: IllegalStateException) {
        }
        assertTrue(ended)
    }
}
