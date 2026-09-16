package com.potatomotato.helm.ui.components

import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The badge may never name a transport it is not actually on. Everything here
 * is about the cases where the honest answer is silence.
 */
class TransportLabelTest {
    @Test
    fun `a live link names the transport carrying it`() {
        assertEquals(R.string.link_transport_ble, transportLabelRes(LinkState.Linked, RANK_BLE))
        assertEquals(R.string.link_transport_lan, transportLabelRes(LinkState.Linked, RANK_LAN))
    }

    @Test
    fun `a link that is not up names nothing, whatever rank is left lying around`() {
        // Ownership outlives the link by a beat when a transport drops, so a
        // stale rank IS reachable here. Reading it would make the badge say
        // "Linked · LAN" next to a grey dot.
        for (state in listOf(LinkState.Advertising, LinkState.Connecting, LinkState.Disconnected)) {
            assertNull(state.name, transportLabelRes(state, RANK_LAN))
        }
    }

    @Test
    fun `an unknown or absent rank names nothing rather than guessing`() {
        assertNull(transportLabelRes(LinkState.Linked, null))
        // A rank from a transport a future build adds. Falling back to "BT"
        // would put a confident wrong word in front of the user.
        assertNull(transportLabelRes(LinkState.Linked, 99))
    }
}
