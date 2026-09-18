package com.potatomotato.helm.ble

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * HelmLink ownership — which transport's bytes actually leave the phone.
 *
 * The phone can hold a Bluetooth link and a LAN link at once, and only one of
 * them may be THE link. Both directions matter and the second one is the one
 * that is easy to get wrong: an upgrade that cannot be undone leaves the phone
 * dead when LAN drops, because Bluetooth attached once at startup and nothing
 * would re-attach it.
 */
class HelmLinkOwnershipTest {

    @After
    fun tearDown() {
        HelmLink.onLinkChanged = null
        HelmLink.detach()
    }

    private fun sink(into: MutableList<ByteArray>): (ByteArray) -> Unit = { into += it }

    /** Attach a transport and declare it connected, as a real one would. */
    private fun live(rank: Int, into: MutableList<ByteArray>) {
        HelmLink.attach(rank, send = sink(into))
        HelmLink.publishState(rank, LinkState.Linked)
    }

    @Test
    fun `LAN takes the link from a live Bluetooth link`() {
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        live(RANK_BLE, ble)

        live(RANK_LAN, lan)

        assertTrue(HelmLink.send(byteArrayOf(1)))
        assertArrayEquals(byteArrayOf(1), lan.single())
        assertTrue("the displaced transport must stop sending", ble.isEmpty())
    }

    @Test
    fun `Bluetooth resumes automatically when LAN drops`() {
        // THE case the single-holder design got wrong. Bluetooth is still
        // attached the whole time, so there is no restore path to run — and
        // therefore none to forget to run.
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        live(RANK_BLE, ble)
        live(RANK_LAN, lan)

        HelmLink.detachRank(RANK_LAN)

        assertEquals(RANK_BLE, HelmLink.holderRank)
        assertTrue(HelmLink.send(byteArrayOf(2)))
        assertArrayEquals(byteArrayOf(2), ble.single())
    }

    @Test
    fun `a lower-ranked transport attaching does not steal the link`() {
        val lan = mutableListOf<ByteArray>()
        val ble = mutableListOf<ByteArray>()
        live(RANK_LAN, lan)

        assertFalse("attaching is not owning", HelmLink.attach(RANK_BLE, send = sink(ble)))

        HelmLink.send(byteArrayOf(3))
        assertArrayEquals(byteArrayOf(3), lan.single())
    }

    @Test
    fun `a displaced transport tearing down later does NOT drop the live link`() {
        // The Bluetooth link that LAN replaced still closes on its own schedule.
        // Ranks are addressed individually, so that teardown cannot reach LAN.
        val lan = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE) { }
        live(RANK_LAN, lan)

        HelmLink.detachRank(RANK_BLE)

        assertEquals(RANK_LAN, HelmLink.holderRank)
        assertTrue(HelmLink.send(byteArrayOf(4)))
    }

    @Test
    fun `releasing the last transport drops the link`() {
        val lan = mutableListOf<ByteArray>()
        live(RANK_LAN, lan)

        HelmLink.detachRank(RANK_LAN)

        assertNull(HelmLink.holderRank)
        assertEquals(LinkState.Disconnected, HelmLink.state.value)
        assertFalse(HelmLink.send(byteArrayOf(5)))
    }

    @Test
    fun `the reported state follows whichever transport owns the link`() {
        // Not a race between two writers: Bluetooth saying "Advertising" while
        // LAN is connected must not make the UI claim the phone is offline.
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        live(RANK_LAN, lan)
        HelmLink.attach(RANK_BLE, send = sink(ble))

        HelmLink.publishState(RANK_BLE, LinkState.Advertising)

        assertEquals(LinkState.Linked, HelmLink.state.value)
    }

    @Test
    fun `the state reverts to the surviving transport's own state on a drop`() {
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE, send = sink(ble))
        HelmLink.publishState(RANK_BLE, LinkState.Advertising)
        live(RANK_LAN, lan)
        assertEquals(LinkState.Linked, HelmLink.state.value)

        HelmLink.detachRank(RANK_LAN)

        // Bluetooth is advertising, not linked — and that is what must be shown,
        // rather than the "Linked" LAN left behind.
        assertEquals(LinkState.Advertising, HelmLink.state.value)
        assertFalse(HelmLink.send(byteArrayOf(6)))
    }

    @Test
    fun `re-attaching a transport keeps the state it had`() {
        // The radio recovery re-runs bringUp on a link that is already up; that
        // must not silently reset it to Disconnected mid-transfer.
        val ble = mutableListOf<ByteArray>()
        live(RANK_BLE, ble)

        HelmLink.attach(RANK_BLE, send = sink(ble))

        assertEquals(LinkState.Linked, HelmLink.state.value)
        assertTrue(HelmLink.send(byteArrayOf(7)))
    }

    @Test
    fun `a send goes nowhere while the owning transport is not yet linked`() {
        val sent = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_LAN, send = sink(sent))
        HelmLink.publishState(RANK_LAN, LinkState.Connecting)

        assertFalse(HelmLink.send(byteArrayOf(8)))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a state report for an unattached transport is ignored`() {
        HelmLink.publishState(RANK_LAN, LinkState.Linked)

        assertNull(HelmLink.holderRank)
        assertEquals(LinkState.Disconnected, HelmLink.state.value)
    }

    @Test
    fun `the channel is rebuilt BEFORE attach returns, not on a later coroutine`() {
        // Found on real hardware. The desktop sends its HELLO the instant it
        // accepts the new transport, and the new transport pumps it immediately.
        // A listener that merely observes the owner flow has not run yet, so the
        // OLD channel's collector eats that HELLO — the queue is consume-once, so
        // it is gone — and then ANSWERS it with the old session's keys down the
        // new socket. The desktop reported "Peer confirmation MAC failed".
        //
        // So the rebuild has to have happened by the time attach() returns.
        val rebuilds = mutableListOf<Pair<Int?, LinkState>>()
        HelmLink.onLinkChanged = { owner, state -> rebuilds += owner to state }

        HelmLink.attach(RANK_BLE) { }
        HelmLink.publishState(RANK_BLE, LinkState.Linked)
        val before = rebuilds.size
        HelmLink.attach(RANK_LAN) { }

        assertTrue("ownership moved without telling the channel", rebuilds.size > before)
        assertEquals(RANK_LAN, rebuilds.last().first)
    }

    @Test
    fun `a transport re-attaching at the same rank does not churn the channel`() {
        // The radio recovery re-runs bringUp on a link that is already up. Tearing
        // the session down there would drop a working link for no reason.
        HelmLink.attach(RANK_BLE) { }
        HelmLink.publishState(RANK_BLE, LinkState.Linked)
        val rebuilds = mutableListOf<Pair<Int?, LinkState>>()
        HelmLink.onLinkChanged = { owner, state -> rebuilds += owner to state }

        HelmLink.attach(RANK_BLE) { }

        assertTrue("nothing changed, so nothing should be rebuilt", rebuilds.isEmpty())
    }

    @Test
    fun `a channel reads only its own transport's bytes`() = runBlocking {
        // Found on hardware: a 55KB reply still draining over Bluetooth after a
        // LAN upgrade was pumped into the NEW LAN channel — sealed with the OLD
        // session's keys, it failed authentication ("Frame authentication
        // failed") and flapped the link. Inbound is per transport: a channel
        // bound to one rank can never consume another transport's tail.
        HelmLink.attach(RANK_BLE) { }
        HelmLink.attach(RANK_LAN) { }
        val lanReceived = CompletableDeferred<ByteArray>()

        HelmLink.publishInbound(RANK_BLE, byteArrayOf(1))
        val collector = launch(Dispatchers.Unconfined) {
            HelmLink.inboundFor(RANK_LAN).collect { lanReceived.complete(it) }
        }
        HelmLink.publishInbound(RANK_LAN, byteArrayOf(2))

        assertArrayEquals(byteArrayOf(2), withTimeout(5_000) { lanReceived.await() })
        collector.cancel()
    }

    @Test
    fun `a retired transport's unread tail is discarded with it`() = runBlocking {
        HelmLink.attach(RANK_BLE) { }
        HelmLink.attach(RANK_LAN) { }
        HelmLink.publishInbound(RANK_BLE, byteArrayOf(1))

        HelmLink.detachRank(RANK_BLE)

        assertNull(withTimeoutOrNull(500) { HelmLink.inboundFor(RANK_BLE).firstOrNull() })
    }

    @Test
    fun `a send racing another transport's teardown never throws`() {
        // Found on hardware: the desktop retires Bluetooth right after a LAN
        // upgrade, so Bluetooth churns its transport entry on a binder thread
        // while the main thread answers a keepalive. The unsynchronised map
        // threw ConcurrentModificationException — a null-message error that
        // surfaced as "link write failed" and flapped the link every ~35s.
        HelmLink.attach(RANK_LAN) { }
        HelmLink.publishState(RANK_LAN, LinkState.Linked)

        val churn = Thread {
            repeat(50_000) {
                HelmLink.attach(RANK_BLE) { }
                HelmLink.detachRank(RANK_BLE)
            }
        }
        churn.start()
        repeat(500_000) { HelmLink.send(byteArrayOf(9)) }
        churn.join()

        assertTrue(HelmLink.send(byteArrayOf(9)))
    }
}

