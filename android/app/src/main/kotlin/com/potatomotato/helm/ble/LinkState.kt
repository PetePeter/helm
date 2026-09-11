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
