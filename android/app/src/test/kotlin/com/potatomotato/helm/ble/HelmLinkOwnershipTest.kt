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
 * The phone can hold a Bluetooth link and a LAN link at the same time, and only
 * one of them may be the link. Getting this wrong is not a cosmetic bug: the
 * displaced transport eventually tears down, and a naive release would take the
 * live link with it. That is the desktop's P-0752 footgun, from the other end.
 */
class HelmLinkOwnershipTest {

    @After
    fun tearDown() {
        HelmLink.detach()
        HelmLink.publishState(LinkState.Disconnected)
    }

    private fun sink(into: MutableList<ByteArray>): (ByteArray) -> Unit = { into += it }

    @Test
    fun `LAN takes the link from a live Bluetooth link`() {
        val ble = mutableListOf<ByteArray>()
        val lan = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE, sink(ble))

        assertTrue(HelmLink.attach(RANK_LAN, sink(lan)))

        HelmLink.publishState(LinkState.Linked)
        HelmLink.send(byteArrayOf(1))
        assertArrayEquals(byteArrayOf(1), lan.single())
        assertTrue("the displaced transport must stop sending", ble.isEmpty())
    }

    @Test
    fun `Bluetooth cannot take the link back while LAN holds it`() {
        val lan = mutableListOf<ByteArray>()
        val ble = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_LAN, sink(lan))

        assertFalse(HelmLink.attach(RANK_BLE, sink(ble)))

        HelmLink.publishState(LinkState.Linked)
        HelmLink.send(byteArrayOf(2))
        assertArrayEquals(byteArrayOf(2), lan.single())
    }

    @Test
    fun `a transport cannot displace itself mid-stream`() {
        // A radio recovery re-running bringUp must not swap the sender out from
        // under a transfer that is already in flight.
        val first = mutableListOf<ByteArray>()
        val second = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE, sink(first))

        assertFalse(HelmLink.attach(RANK_BLE, sink(second)))

        HelmLink.publishState(LinkState.Linked)
        HelmLink.send(byteArrayOf(3))
        assertArrayEquals(byteArrayOf(3), first.single())
    }

    @Test
    fun `a displaced transport tearing down later does NOT drop the live link`() {
        // THE footgun. The Bluetooth link that LAN replaced still closes on its
        // own schedule, and its release must be a no-op.
        val lan = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_BLE) { }
        HelmLink.attach(RANK_LAN, sink(lan))

        HelmLink.detachRank(RANK_BLE)

        assertEquals(RANK_LAN, HelmLink.holderRank)
        HelmLink.publishState(LinkState.Linked)
        assertTrue(HelmLink.send(byteArrayOf(4)))
    }

    @Test
    fun `releasing the transport that DOES hold the link drops it`() {
        HelmLink.attach(RANK_LAN) { }

        HelmLink.detachRank(RANK_LAN)

        assertNull(HelmLink.holderRank)
        assertEquals(LinkState.Disconnected, HelmLink.state.value)
        assertFalse(HelmLink.send(byteArrayOf(5)))
    }

    @Test
    fun `a send goes nowhere while the link is not yet linked`() {
        // Attached is not connected: the handshake has to finish first.
        val sent = mutableListOf<ByteArray>()
        HelmLink.attach(RANK_LAN, sink(sent))
        HelmLink.publishState(LinkState.Connecting)

        assertFalse(HelmLink.send(byteArrayOf(6)))
        assertTrue(sent.isEmpty())
    }
}
