package com.potatomotato.helm.ble

/**
 * The link as the user sees it on the status line.
 *
 * There is no "Reconnecting": the phone cannot initiate. When Helm goes away
 * the phone simply returns to [Advertising] and waits, which is exactly what
 * the user should be told is happening.
 */
enum class LinkState {
    /** Radio up, advertising the Helm service, nobody connected. */
    Advertising,

    /** A central is connected but has not subscribed to TX yet. */
    Connecting,

    /** Subscribed both ways — bytes can flow. */
    Linked,

    /** Not advertising: stopped, or the radio/permission is unavailable. */
    Disconnected,
}

/**
 * Transport ranks. Higher holds the link. Mirrors the desktop's RANK_BLE /
 * RANK_LAN so both ends prefer the same pipe without negotiating it.
 *
 * Bluetooth is ~5-20 KB/s and works anywhere; LAN is not and does not. There is
 * nothing to weigh, so this is a fixed ordering rather than a heuristic.
 */
const val RANK_BLE = 1
const val RANK_LAN = 2

