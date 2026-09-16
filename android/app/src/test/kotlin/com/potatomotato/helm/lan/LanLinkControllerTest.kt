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

    private open class FakeConnection(incoming: ByteArray = ByteArray(0)) : LanLinkSession.Connection {
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

    /** Every pump body kept, so overlapping links can end in order. */
    private class PumpQueue : (() -> Unit) -> Unit {
        val bodies = mutableListOf<() -> Unit>()
        override fun invoke(p1: () -> Unit) { bodies += p1 }
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
    fun `a trigger arriving while a dial is in flight makes no second attempt`() {
        // The address push and the link-up collector can both fire while the
        // first dial is still blocking. On hardware that second socket raced
        // the first for the rank, and the loser's teardown killed the winner.
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        lateinit var controller: LanLinkController
        val dialer = object : LanLinkSession.Dialer {
            val attempts = mutableListOf<String>()
            var reentered = false
            override fun dial(host: String, port: Int): LanLinkSession.Connection {
                attempts += "$host:$port"
                if (!reentered) {
                    reentered = true
                    controller.tryConnect("desk")
                }
                return FakeConnection()
            }
        }
        controller = LanLinkController(store, dialer, PumpQueue())

        controller.tryConnect("desk")

        assertEquals(1, dialer.attempts.size)
    }

    @Test
    fun `a dead session unwinding late does not release a fresher link's rank`() {
        // The socket dies, the next Bluetooth link-up dials again, and only
        // THEN does the old pump's teardown run. Releasing the rank then would
        // detach the fresh link, whose next write fails — the flap seen on hw.
        HelmLink.attach(RANK_BLE) { }
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        lateinit var controller: LanLinkController
        var firstClose = true
        val first = object : FakeConnection() {
            override fun close() {
                super.close()
                if (firstClose) {
                    firstClose = false
                    // Fires inside pump(), after the connection is dead but
                    // before the controller's teardown has run.
                    controller.tryConnect("desk")
                }
            }
        }
        val attempts = mutableListOf<String>()
        val dialer = LanLinkSession.Dialer { host, port ->
            attempts += "$host:$port"
            if (attempts.size == 1) first else FakeConnection()
        }
        val pump = PumpQueue()
        controller = LanLinkController(store, dialer, pump)
        controller.tryConnect("desk")
        assertEquals(RANK_LAN, HelmLink.holderRank)

        // The old link's pump unwinds — AFTER the fresh dial already took over.
        pump.bodies[0]()

        assertEquals(2, attempts.size)
        assertEquals(RANK_LAN, HelmLink.holderRank)

        // The fresh link still tears down cleanly when its own turn comes.
        pump.bodies[1]()
        assertEquals(RANK_BLE, HelmLink.holderRank)
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

    @Test
    fun `a LAN write is carried off the caller's thread`() {
        // Found on hardware: Android forbids network I/O on the main thread,
        // and the app's first call (session_list, right after Linked) arrives
        // there. The BLE transport absorbs any caller by queueing; LAN must do
        // the same or every upgrade dies with NetworkOnMainThreadException.
        val store = MemoryAddresses(mutableMapOf("desk" to listOf("192.168.1.20:47475")))
        val connection = FakeConnection()
        val pump = DeferredPump()
        val writes = DeferredPump()
        val controller = LanLinkController(
            store,
            FakeDialer(mapOf("192.168.1.20:47475" to connection)),
            pump,
            runWrite = writes,
        )
        controller.tryConnect("desk")

        assertTrue(HelmLink.send(byteArrayOf(11)))
        assertTrue(
            "the socket must not be touched on the caller's thread",
            (connection.output as ByteArrayOutputStream).size() == 0,
        )

        writes.run()

        assertEquals(1, (connection.output as ByteArrayOutputStream).size())
    }
}
