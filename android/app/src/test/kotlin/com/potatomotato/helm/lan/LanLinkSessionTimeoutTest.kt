package com.potatomotato.helm.lan

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A silently dead socket — the desktop gone without a FIN, a wifi AP that
 * stopped forwarding — must end the session on a read timeout rather than sit
 * "Linked" until TCP gives up ten-plus minutes later. Real sockets, loopback.
 */
class LanLinkSessionTimeoutTest {

    @Test
    fun `a silent server closes the session with a timeout reason`() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            // Accepts and then says nothing, ever.
            val accepted = Thread { runCatching { server.accept() } }.apply { isDaemon = true; start() }
            val logs = mutableListOf<String>()
            val states = mutableListOf<LanLinkState>()
            val session = LanLinkSession(
                dialer = tcpDialer(readTimeoutMs = 300),
                onBytes = {},
                onStateChange = { states += it },
                log = { synchronized(logs) { logs += it } },
            )
            assertTrue(session.connect(listOf("127.0.0.1:${server.localPort}")) != null)

            val started = System.nanoTime()
            session.pump()
            val elapsedMs = (System.nanoTime() - started) / 1_000_000

            assertTrue("pump took ${elapsedMs}ms", elapsedMs in 250..5_000)
            assertTrue(logs.toString(), logs.any { it.contains("reason=timeout") && it.contains("lifetime=") })
            assertTrue(states.last() == LanLinkState.Idle)
            accepted.join(1_000)
        }
    }

    @Test
    fun `a server that hangs up closes the session with an EOF reason`() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            Thread { runCatching { server.accept().close() } }.apply { isDaemon = true; start() }
            val logs = mutableListOf<String>()
            val session = LanLinkSession(tcpDialer(readTimeoutMs = 5_000), {}, {}, log = { logs += it })
            session.connect(listOf("127.0.0.1:${server.localPort}"))

            session.pump()

            assertTrue(logs.toString(), logs.any { it.contains("reason=eof") })
        }
    }
}
