package com.potatomotato.helm.ble

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
    fun tearDown() = HelmLink.detach()

    private fun sink(into: MutableList<ByteArray>): (ByteArray) -> Unit = { into += it }

    /** Attach a transport and declare it connected, as a real one would. */
    private fun live(rank: Int, into: MutableList<ByteArray>) {
        HelmLink.attach(rank, sink(into))
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

        assertFalse("attaching is not owning", HelmLink.attach(RANK_BLE, sink(ble)))

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
        HelmLink.attach(RANK_BLE, sink(ble))

        HelmLink.publishState(RANK_BLE, LinkState.Advertising)

        assertEquals(LinkState.Linked, HelmLink.state.value)
    }

    @Test
    fun `the state reverts to the surviving transport's own state on a drop`() {
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE, sink(ble))
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

        HelmLink.attach(RANK_BLE, sink(ble))

        assertEquals(LinkState.Linked, HelmLink.state.value)
        assertTrue(HelmLink.send(byteArrayOf(7)))
    }

    @Test
    fun `a send goes nowhere while the owning transport is not yet linked`() {
        val sent = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_LAN, sink(sent))
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
}
