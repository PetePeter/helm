package com.potatomotato.helm.lan

import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import com.potatomotato.helm.data.LanAddressStore
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LanLinkController — WHEN the phone dials, and what owns the link afterwards.
 *
 * The pump runs inline here rather than on a thread, so a test observes the
 * whole life of a link deterministically.
 */
class LanLinkControllerTest {

    @After
    fun tearDown() = HelmLink.detach()

    private class MemoryAddresses(private val byMachine: MutableMap<String, List<String>>) :
        LanAddressStore {
        override fun save(machineId: String, addresses: List<String>) {
            byMachine[machineId] = addresses
        }
        override fun load(machineId: String) = byMachine[machineId] ?: emptyList()
        override fun forget(machineId: String) { byMachine.remove(machineId) }
    }

    private class FakeConnection(incoming: ByteArray = ByteArray(0)) : LanLinkSession.Connection {
        override val input: InputStream = ByteArrayInputStream(incoming)
        override val output: OutputStream = ByteArrayOutputStream()
        var closed = false
        override fun close() { closed = true }
    }

    private class FakeDialer(private val reachable: Map<String, FakeConnection>) :
        LanLinkSession.Dialer {
        val attempts = mutableListOf<String>()
        override fun dial(host: String, port: Int): LanLinkSession.Connection {
            attempts += "$host:$port"
            return reachable["$host:$port"] ?: throw IOException("unreachable")
        }
    }

    /** `pump` deferred, so a test can inspect the link while it is still up. */
    private class DeferredPump : (() -> Unit) -> Unit {
        var body: (() -> Unit)? = null
        override fun invoke(p1: () -> Unit) { body = p1 }
        fun run() { body?.invoke() }
    }

    @Test
    fun `does not dial when no address has ever been pushed`() {
        val dialer = FakeDialer(emptyMap())
        LanLinkController(MemoryAddresses(mutableMapOf()), dialer, DeferredPump()).tryConnect("desk")

        assertTrue(dialer.attempts.isEmpty())
    }

    @Test
    fun `does not dial when the desktop said to stop`() {
        // An empty pushed list is the desktop turning LAN off.
        val dialer = FakeDialer(emptyMap())
        val store = MemoryAddresses(mutableMapOf("desk" to emptyList()))

        LanLinkController(store, dialer, DeferredPump()).tryConnect("desk")

        assertTrue(dialer.attempts.isEmpty())
    }

    @Test
    fun `a LAN link takes the link from Bluetooth once it is open`() {
        val ble = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE) { ble += it }
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to FakeConnection()))

        LanLinkController(store, dialer, DeferredPump()).tryConnect("desk")

        assertEquals(RANK_LAN, HelmLink.holderRank)
    }

    @Test
    fun `an unreachable desktop leaves Bluetooth holding the link`() {
        // The ordinary case away from home. It must cost the existing link
        // nothing at all.
        HelmLink.attach(RANK_BLE) { }
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))

        LanLinkController(store, FakeDialer(emptyMap()), DeferredPump()).tryConnect("desk")

        assertEquals(RANK_BLE, HelmLink.holderRank)
    }

    @Test
    fun `Bluetooth gets the link back when the LAN link ends`() {
        HelmLink.attach(RANK_BLE) { }
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        val connection = FakeConnection()
        val pump = DeferredPump()
        LanLinkController(store, FakeDialer(mapOf("192.168.1.20:47475" to connection)), pump)
            .tryConnect("desk")
        assertEquals(RANK_LAN, HelmLink.holderRank)

        // The stream ends, exactly as a dropped wifi connection would end it.
        pump.run()

        assertEquals(RANK_BLE, HelmLink.holderRank)
        assertTrue(connection.closed)
    }

    @Test
    fun `does not dial again while a LAN link is already up`() {
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        val dialer = FakeDialer(mapOf("192.168.1.20:47475" to FakeConnection()))
        val controller = LanLinkController(store, dialer, DeferredPump())

        controller.tryConnect("desk")
        controller.tryConnect("desk")

        assertEquals(1, dialer.attempts.size)
    }

    @Test
    fun `stopping drops the LAN link and hands back to Bluetooth`() {
        HelmLink.attach(RANK_BLE) { }
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        val connection = FakeConnection()
        val controller =
            LanLinkController(store, FakeDialer(mapOf("192.168.1.20:47475" to connection)), DeferredPump())
        controller.tryConnect("desk")

        controller.stop()

        assertFalse(controller.connected)
        assertEquals(RANK_BLE, HelmLink.holderRank)
        assertTrue(connection.closed)
    }
}
