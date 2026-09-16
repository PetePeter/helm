package com.potatomotato.helm.lan

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LanLinkSession — the phone's dialling policy.
 *
 * Driven against real streams and a fake dialler rather than real sockets: what
 * is under test is WHICH address is tried and what each outcome means, not
 * whether TCP works.
 */
class LanLinkSessionTest {

    private class FakeConnection(
        incoming: ByteArray = ByteArray(0),
        val sink: ByteArrayOutputStream = ByteArrayOutputStream(),
    ) : LanLinkSession.Connection {
        override val input: InputStream = ByteArrayInputStream(incoming)
        override val output: OutputStream = sink
        var closed = false
        override fun close() { closed = true }
    }

    /** Records every dial, and answers only for the addresses it was told to. */
    private class FakeDialer(
        private val reachable: Map<String, FakeConnection> = emptyMap(),
    ) : LanLinkSession.Dialer {
        val attempts = mutableListOf<String>()
        override fun dial(host: String, port: Int): LanLinkSession.Connection {
            val key = "$host:$port"
            attempts += key
            return reachable[key] ?: throw IOException("unreachable")
        }
    }

    private fun session(
        dialer: LanLinkSession.Dialer,
        onBytes: (ByteArray) -> Unit = {},
        states: MutableList<LanLinkState> = mutableListOf(),
    ) = LanLinkSession(dialer, onBytes, { states += it })

    @Test
    fun `keeps the first address that answers`() {
        val open = FakeConnection()
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to open))

        val connection = session(dialer).connect(listOf("10.0.0.9:47475", "192.168.1.20:47475"))

        assertEquals(open, connection)
        // Tried in the order given, and stopped as soon as one answered.
        assertEquals(listOf("10.0.0.9:47475", "192.168.1.20:47475"), dialer.attempts)
    }

    @Test
    fun `returns null when nothing answers, without treating it as an error`() {
        // This is the ORDINARY case away from home. It must be quiet.
        val dialer = FakeDialer()
        val states = mutableListOf<LanLinkState>()

        val connection = session(dialer, states = states).connect(listOf("192.168.1.20:47475"))

        assertNull(connection)
        assertEquals(listOf(LanLinkState.Dialling, LanLinkState.Idle), states)
    }

    @Test
    fun `does not dial at all when the desktop sent an empty list`() {
        // An empty list is the instruction "stop dialling", not "try harder".
        val dialer = FakeDialer()
        val states = mutableListOf<LanLinkState>()

        assertNull(session(dialer, states = states).connect(emptyList()))

        assertTrue(dialer.attempts.isEmpty())
        assertEquals(listOf(LanLinkState.Idle), states)
    }

    @Test
    fun `skips a malformed address instead of guessing at it`() {
        // Guessing at "192.168.1.20" would mean inventing a port — and the
        // failure mode of a wrong guess is dialling a stranger.
        val open = FakeConnection()
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to open))

        session(dialer).connect(listOf("nonsense", "192.168.1.20:70000", "192.168.1.20:47475"))

        assertEquals(listOf("192.168.1.20:47475"), dialer.attempts)
    }

    @Test
    fun `hands the caller raw bytes rather than framed messages`() {
        // SecureChannel splits on its own length prefix, so this layer must not
        // impose one. A chunker here would be BLE's framing leaking into TCP.
        val payload = byteArrayOf(1, 2, 3, 4, 5)
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to FakeConnection(payload)))
        val received = mutableListOf<ByteArray>()
        val link = session(dialer, onBytes = { received += it })

        link.connect(listOf("192.168.1.20:47475"))
        link.pump()

        assertArrayEquals(payload, received.single())
    }

    @Test
    fun `a closed stream ends the pump cleanly and closes the connection`() {
        val open = FakeConnection()
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to open))
        val link = session(dialer)
        link.connect(listOf("192.168.1.20:47475"))

        link.pump()

        assertTrue(open.closed)
        assertFalse(link.connected)
    }

    @Test
    fun `sends bytes to the desktop`() {
        val open = FakeConnection()
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to open))
        val link = session(dialer)
        link.connect(listOf("192.168.1.20:47475"))

        assertTrue(link.send(byteArrayOf(7, 7)))

        assertArrayEquals(byteArrayOf(7, 7), open.sink.toByteArray())
    }

    @Test
    fun `a send with no connection fails rather than throwing`() {
        // The layer above decides whether a refused write matters; it must never
        // learn about it as an exception from a link that simply is not there.
        assertFalse(session(FakeDialer()).send(byteArrayOf(1)))
    }

    @Test
    fun `a failed write closes the link instead of leaving it half alive`() {
        val broken = object : LanLinkSession.Connection {
            override val input: InputStream = ByteArrayInputStream(ByteArray(0))
            override val output: OutputStream = object : OutputStream() {
                override fun write(b: Int) = throw IOException("broken pipe")
            }
            var closed = false
            override fun close() { closed = true }
        }
        val dialer = object : LanLinkSession.Dialer {
            override fun dial(host: String, port: Int) = broken
        }
        val link = session(dialer)
        link.connect(listOf("192.168.1.20:47475"))

        assertFalse(link.send(byteArrayOf(1)))
        assertFalse(link.connected)
    }

    @Test
    fun `close is idempotent`() {
        val open = FakeConnection()
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to open))
        val link = session(dialer)
        link.connect(listOf("192.168.1.20:47475"))

        link.close()
        link.close()

        assertTrue(open.closed)
    }
}
