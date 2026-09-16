package com.potatomotato.helm.ui.components

import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN

/**
 * Which transport is carrying the link, as a word for the badge.
 *
 * "Linked" alone was a real gap: Bluetooth and wifi feel completely different
 * to use — one is ~5-20 KB/s, the other is not — and the app said the same word
 * for both, so the only way to find out was to read the desktop's log for
 * "moved from rank 1 to 2". The rank is already on the phone; it just was not
 * being said.
 *
 * Null means "name no transport", and it is the answer to every case where a
 * name would be a guess: no link, a link still being set up, or a rank this
 * build does not know. Claiming BT because the rank was unrecognised would be
 * worse than the silence it replaced — the badge's whole job is to be trusted
 * at a glance.
 */
fun transportLabelRes(state: LinkState, rank: Int?): Int? {
    if (state != LinkState.Linked) return null
    return when (rank) {
        RANK_BLE -> R.string.link_transport_ble
        RANK_LAN -> R.string.link_transport_lan
        else -> null
    }
}
