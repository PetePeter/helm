package com.potatomotato.helm.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** The link lifecycle, driven through the same events the GATT server raises. */
class BleLinkSessionTest {
    private val peripheral = FakeGattPeripheral()
    private val scheduler = FakeScheduler()
    private val messages = mutableListOf<ByteArray>()
    private val states = mutableListOf<LinkState>()
    private val logs = mutableListOf<String>()

    private val session = BleLinkSession(
        peripheral = peripheral,
        scheduler = scheduler,
        onMessage = { messages.add(it) },
        onStateChange = { states.add(it) },
        log = { logs.add(it) },
    )

    private val helm = "AA:BB:CC:DD:EE:FF"

    private fun link(address: String = helm, mtu: Int = 185) {
        session.start()
        session.onAdvertiseStarted()
        session.onCentralConnected(address)
        session.onMtuChanged(address, mtu)
        session.onTxSubscribed(address)
    }

    @Test
    fun `start advertises and reports Advertising`() {
        session.start()
        session.onAdvertiseStarted()

        assertEquals(1, peripheral.advertiseStarts)
        assertEquals(LinkState.Advertising, session.state)
    }

    @Test
    fun `a connected central that subscribes reaches Linked`() {
        link()

        assertEquals(LinkState.Linked, session.state)
        assertEquals(listOf(LinkState.Advertising, LinkState.Connecting, LinkState.Linked), states)
        // Advertising stops on connect so a second central is never invited in.
        assertTrue(peripheral.advertiseStops >= 1)
    }

    @Test
    fun `a second central is disconnected and never takes the link`() {
        link()
        val intruder = "11:22:33:44:55:66"

        session.onCentralConnected(intruder)

        assertEquals(listOf(intruder), peripheral.disconnected)
        assertEquals(helm, session.centralAddress)
        assertEquals(LinkState.Linked, session.state)
    }

    @Test
    fun `writes from an address that does not hold the link are ignored`() {
        link()
        val message = Random(1).nextBytes(8)
        val chunks = BleChunker().chunk(message, session.chunkSize)

        chunks.forEach { session.onRxWrite("99:99:99:99:99:99", it) }

        assertEquals(0, messages.size)
    }

    @Test
    fun `inbound chunks are reassembled and surfaced whole`() {
        link()
        val message = Random(2).nextBytes(700)
        BleChunker().chunk(message, session.chunkSize).forEach { session.onRxWrite(helm, it) }

        assertEquals(listOf(message.toHex()), messages.map { it.toHex() })
    }

    @Test
    fun `outbound chunks wait for the stack to acknowledge each notification`() {
        link()
        session.send(Random(3).nextBytes(700))

        // Exactly one chunk on the wire until the stack acknowledges it.
        assertEquals(1, peripheral.notified.size)
        assertTrue(session.pendingChunks > 0)

        while (session.pendingChunks > 0) session.onNotificationSent(helm, true)
        session.onNotificationSent(helm, true)

        val roundTripped = mutableListOf<ByteArray>()
        val reassembler = BleReassembler({ roundTripped.add(it) }, { throw AssertionError(it) })
        peripheral.notified.forEach(reassembler::push)
        assertEquals(1, roundTripped.size)
    }

    @Test
    fun `the negotiated MTU sizes outbound chunks`() {
        link(mtu = 517)
        assertEquals(BleFraming.chunkSizeForMtu(517), session.chunkSize)

        session.send(Random(4).nextBytes(400))

        assertEquals(1, peripheral.notified.size)
        assertTrue(peripheral.notified[0].size <= session.chunkSize)
        assertEquals(0, session.pendingChunks)
    }

    @Test
    fun `sending before the central subscribes queues rather than dropping`() {
        session.start()
        session.onAdvertiseStarted()
        session.onCentralConnected(helm)

        session.send(Random(5).nextBytes(10))
        assertEquals(0, peripheral.notified.size)

        session.onTxSubscribed(helm)
        assertEquals(1, peripheral.notified.size)
    }

    @Test
    fun `a refused notification clears the queue instead of sending a hole`() {
        link()
        peripheral.acceptNotifications = false

        session.send(Random(6).nextBytes(700))

        assertEquals(0, peripheral.notified.size)
        assertEquals(0, session.pendingChunks)
        assertTrue(logs.any { it.contains("rejected") })
    }

    @Test
    fun `a disconnect returns to advertising exactly once, with no tight loop`() {
        link()
        peripheral.acceptNotifications = true
        val startsBefore = peripheral.advertiseStarts

        session.onCentralDisconnected(helm)
        session.onAdvertiseStarted()

        assertEquals(startsBefore + 1, peripheral.advertiseStarts)
        assertEquals(LinkState.Advertising, session.state)
        assertNull(session.centralAddress)
        assertEquals(emptyList<Long>(), scheduler.delays)
    }

    @Test
    fun `a disconnect resets the MTU and drops queued chunks`() {
        link(mtu = 517)
        session.send(Random(7).nextBytes(4_000))

        session.onCentralDisconnected(helm)

        assertEquals(BleFraming.MIN_CHUNK_BYTES, session.chunkSize)
        assertEquals(0, session.pendingChunks)
    }

    @Test
    fun `advertising failure backs off instead of spinning`() {
        session.start()
        session.onAdvertiseFailed("DATA_TOO_LARGE")
        session.onAdvertiseFailed("ALREADY_STARTED")

        // One retry in flight at a time, whatever the failure rate.
        assertEquals(listOf(1_000L), scheduler.delays)

        scheduler.runPending()
        assertEquals(2, peripheral.advertiseStarts)

        session.onAdvertiseFailed("INTERNAL_ERROR")
        assertEquals(listOf(1_000L, 2_000L), scheduler.delays)
    }

    @Test
    fun `a successful advert resets the backoff`() {
        session.start()
        session.onAdvertiseFailed("INTERNAL_ERROR")
        scheduler.runPending()
        session.onAdvertiseStarted()

        session.onAdvertiseFailed("INTERNAL_ERROR")

        assertEquals(listOf(1_000L, 1_000L), scheduler.delays)
    }

    @Test
    fun `a radio that throws is logged, not propagated`() {
        peripheral.throwOnAdvertise = SecurityException("BLUETOOTH_ADVERTISE denied")

        session.start()

        assertTrue(logs.any { it.contains("SecurityException") })
        assertEquals(LinkState.Disconnected, session.state)
    }

    @Test
    fun `stop drops the central, stops the radio and stays stopped`() {
        link()

        session.stop()

        assertEquals(listOf(helm), peripheral.disconnected)
        assertEquals(LinkState.Disconnected, session.state)
        assertNull(session.centralAddress)

        val startsAfterStop = peripheral.advertiseStarts
        session.onCentralDisconnected(helm)
        assertEquals(startsAfterStop, peripheral.advertiseStarts)
    }

    @Test
    fun `unsubscribing without disconnecting falls back to Connecting`() {
        link()

        session.onTxUnsubscribed(helm)

        assertEquals(LinkState.Connecting, session.state)
        session.send(Random(8).nextBytes(4))
        assertEquals(0, peripheral.notified.size)
    }
}
