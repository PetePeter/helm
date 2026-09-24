package com.potatomotato.helm.ble

import com.potatomotato.helm.fromHex
import com.potatomotato.helm.toHex
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
        // A central that connected IS connected, as far as the radio knows —
        // until a test empties the list to make it a ghost.
        peripheral.connected += address
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
    fun `a notification refused twice clears the queue instead of sending a hole`() {
        link()
        peripheral.acceptNotifications = false

        session.send(Random(6).nextBytes(700))
        // First refusal: the chunk is held for exactly one retry, not dropped.
        assertTrue(session.pendingChunks > 0)
        assertEquals(50L, scheduler.delays.last())

        scheduler.runPending()

        assertEquals(0, peripheral.notified.size)
        assertEquals(0, session.pendingChunks)
        assertEquals(0L, session.pendingBytes)
        assertTrue(logs.any { it.contains("rejected after a retry") })
    }

    @Test
    fun `a chunk refused once is retried after a short delay and the message arrives whole`() {
        link()
        val message = Random(60).nextBytes(700)
        session.send(message)
        assertEquals(1, peripheral.notified.size)

        // The stack reports the notification failed: nothing new goes out yet.
        session.onNotificationSent(helm, false)
        assertEquals(1, peripheral.notified.size)
        assertEquals(50L, scheduler.delays.last())

        scheduler.runPending()
        // The SAME chunk goes out again rather than the next one leaving a hole.
        assertEquals(2, peripheral.notified.size)
        assertEquals(peripheral.notified[0].toHex(), peripheral.notified[1].toHex())

        while (session.pendingChunks > 0) session.onNotificationSent(helm, true)
        session.onNotificationSent(helm, true)

        val roundTripped = mutableListOf<ByteArray>()
        val reassembler = BleReassembler({ roundTripped.add(it) }, { throw AssertionError(it) })
        // The refused first copy never reached the central.
        peripheral.notified.drop(1).forEach(reassembler::push)
        assertEquals(listOf(message.toHex()), roundTripped.map { it.toHex() })
        assertEquals(0L, session.pendingBytes)
    }

    @Test
    fun `an async refusal of the retried chunk discards the rest cleanly`() {
        link()
        session.send(Random(61).nextBytes(700))
        session.onNotificationSent(helm, false)
        scheduler.runPending()
        assertEquals(2, peripheral.notified.size)

        session.onNotificationSent(helm, false)

        assertEquals(0, session.pendingChunks)
        assertEquals(0L, session.pendingBytes)
        assertEquals(2, peripheral.notified.size)
        // The link itself survives; the next message is sent normally.
        session.send(Random(62).nextBytes(10))
        assertEquals(3, peripheral.notified.size)
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
        // The only schedule left is the idle supervisor the link armed — its
        // action no-ops now that no central is held.
        assertEquals(listOf(15_000L), scheduler.delays)
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
    fun `a reconnect resets inbound framing so a fresh sequence is not read as a gap`() {
        link()
        BleChunker().chunk(Random(14).nextBytes(400), session.chunkSize)
            .forEach { session.onRxWrite(helm, it) }
        assertEquals(1, messages.size)

        // Helm walks away and comes back; its fresh chunker restarts at seq 0
        // while this reassembler was left expecting the old count.
        session.onCentralDisconnected(helm)
        link()

        val fresh = Random(15).nextBytes(100)
        BleChunker().chunk(fresh, session.chunkSize).forEach { session.onRxWrite(helm, it) }

        assertEquals(listOf(fresh.toHex()), messages.drop(1).map { it.toHex() })
        assertTrue(logs.none { it.contains("sequence gap") })
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

    @Test
    fun `a notification ack that never arrives tears the link down at the deadline`() {
        link()
        session.send(Random(9).nextBytes(700))
        assertEquals(1, peripheral.notified.size)

        // One deadline armed per chunk put on the wire, and none before —
        // the 15s entry is the idle supervisor, not the ack deadline.
        assertEquals(listOf(15_000L, 10_000L), scheduler.delays)
        scheduler.runPending()

        // A missing ack is a transport failure: the central is dropped, the
        // queue is cleared, and the session is free to re-advertise.
        assertEquals(listOf(helm), peripheral.disconnected)
        assertEquals(0, session.pendingChunks)

        session.onCentralDisconnected(helm)
        session.onAdvertiseStarted()
        assertEquals(LinkState.Advertising, session.state)
        assertNull(session.centralAddress)
    }

    @Test
    fun `sends piling up behind a missing ack do not wedge the link`() {
        link()
        session.send(Random(10).nextBytes(700))
        session.send(Random(11).nextBytes(700))
        session.send(Random(12).nextBytes(700))

        // Still exactly one chunk in flight — the queue holds, it does not
        // duplicate — and the deadline still tears the link down.
        assertEquals(1, peripheral.notified.size)
        assertTrue(session.pendingChunks > 0)

        scheduler.runPending()
        assertEquals(0, session.pendingChunks)
        assertEquals(listOf(helm), peripheral.disconnected)
    }

    @Test
    fun `a healthy link survives its ack deadlines`() {
        link()
        session.send(Random(13).nextBytes(700))
        while (session.pendingChunks > 0) session.onNotificationSent(helm, true)
        // The final chunk's ack, so nothing is left legitimately in flight.
        session.onNotificationSent(helm, true)

        // Every armed deadline fires after the fact; none may tear a live
        // link down, including the stale ones from earlier chunks.
        scheduler.runPending()

        assertEquals(LinkState.Linked, session.state)
        assertTrue(peripheral.disconnected.isEmpty())
    }

    @Test
    fun `interleaved sends and acks from different threads corrupt nothing`() {
        link()
        val messages = (0 until 24).map { Random(100 + it).nextBytes(700) }
        val expectedChunks = messages.sumOf { BleChunker().chunk(it, session.chunkSize).size }
        val failures = mutableListOf<Exception>()
        val reassembled = mutableListOf<ByteArray>()
        val reassembler = BleReassembler(
            onMessage = { reassembled.add(it) },
            onDrop = { throw AssertionError(it) },
        )

        val sender = Thread {
            messages.forEach { session.send(it) }
        }
        val acker = Thread {
            // Generous overshoot: spare acks are no-ops, missing ones stall.
            repeat(expectedChunks + 100) {
                session.onNotificationSent(helm, true)
                Thread.yield()
            }
        }
        sender.uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, e -> failures.add(e as Exception) }
        acker.uncaughtExceptionHandler = sender.uncaughtExceptionHandler
        sender.start()
        acker.start()
        sender.join()
        acker.join()
        while (session.pendingChunks > 0) session.onNotificationSent(helm, true)

        peripheral.notified.forEach(reassembler::push)
        assertEquals(expectedChunks, peripheral.notified.size)
        assertEquals(
            messages.map { it.toHex() }.sorted(),
            reassembled.map { it.toHex() }.sorted(),
        )
        assertEquals(emptyList<Exception>(), failures)
    }

    @Test
    fun `verifyCentral drops a central the radio no longer sees and re-advertises`() {
        // The ghost this exists for: the peer's stack died without an
        // announcement, so the session's echo points at nobody.
        link()
        peripheral.connected.clear()
        val startsBefore = peripheral.advertiseStarts

        session.verifyCentral()

        assertNull(session.centralAddress)
        assertEquals(startsBefore + 1, peripheral.advertiseStarts)
        assertTrue(logs.any { it.contains("without an announcement") })
    }

    @Test
    fun `verifyCentral keeps a central the radio still reports`() {
        link()
        peripheral.connected += helm

        session.verifyCentral()

        assertEquals(helm, session.centralAddress)
        assertEquals(LinkState.Linked, session.state)
    }

    @Test
    fun `the idle supervisor drops a ghost central at its interval`() {
        // Pure listening has no traffic to notice a loss with — the supervisor
        // is the only probe. The radio's truth is emptied, as a silent central
        // death leaves it.
        link()
        peripheral.connected.clear()

        assertEquals(listOf(15_000L), scheduler.delays)
        scheduler.runPending()

        assertNull(session.centralAddress)
        // It does not re-arm once no central is held.
        assertEquals(listOf(15_000L), scheduler.delays)
    }

    /**
     * The backpressure an upload paces itself against. It has to fall only as
     * the STACK acknowledges chunks — counting a chunk as gone the moment it was
     * queued is exactly the lie that made a phone-to-PC upload read 100% in
     * milliseconds and then sit there for minutes.
     */
    @Test
    fun `pending bytes fall only as the stack acknowledges chunks`() {
        link(mtu = 40)
        val message = Random(7).nextBytes(200)

        session.send(message)
        val queued = session.pendingBytes
        assertTrue("a queued message is pending in full", queued >= message.size)

        // The first chunk is on the air but NOT yet acknowledged.
        assertEquals(queued, session.pendingBytes)

        session.onNotificationSent(helm, true)
        val afterOne = session.pendingBytes
        assertTrue("an ack must reduce it", afterOne < queued)
        assertTrue("and only by the one chunk", afterOne > 0)

        while (session.pendingChunks > 0) session.onNotificationSent(helm, true)
        session.onNotificationSent(helm, true)
        assertEquals("a fully drained queue holds nothing", 0L, session.pendingBytes)
    }

    @Test
    fun `a dropped link reports nothing pending rather than a stale backlog`() {
        link(mtu = 40)
        session.send(Random(9).nextBytes(400))
        assertTrue(session.pendingBytes > 0)

        session.onCentralDisconnected(helm)

        // The queue was discarded with the link. A sender still watching this
        // number must see it go to zero, or it waits for a drain that will
        // never come.
        assertEquals(0L, session.pendingBytes)
    }

    @Test
    fun `the idle supervisor re-arms while a live central holds the link`() {
        link()
        peripheral.connected += helm

        scheduler.runPending()

        assertEquals(helm, session.centralAddress)
        assertEquals(listOf(15_000L, 15_000L), scheduler.delays)
    }
}
