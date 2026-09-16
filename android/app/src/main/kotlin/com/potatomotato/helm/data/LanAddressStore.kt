package com.potatomotato.helm.data

/**
 * Where a desktop can be reached over the network, between app launches.
 *
 * Keyed on machineId, exactly like [PskStore]: the same desktop is the same
 * desktop over Bluetooth or LAN, and an IP is a lease, not an identity.
 *
 * WHY THE PHONE HOLDS THIS AT ALL: Helm listens and the phone dials, so the
 * desktop has no address to configure — the phone does. Left as something the
 * user typed, that address dies silently the day the desktop's DHCP lease
 * moves. So the desktop pushes its own addresses down the authenticated link
 * (P-0752) and this is where they land, refreshed on every connection.
 *
 * NOT A SECRET, and deliberately stored in the clear: an address is public on
 * the network it names. What makes it safe is that it is only ever ACCEPTED
 * from an authenticated channel — see [com.potatomotato.helm.wire.MobileRecord.Lan].
 *
 * An interface so the dialling logic is testable without a device.
 */
interface LanAddressStore {
    /**
     * Replace everything known for this desktop.
     *
     * REPLACE, not merge: the desktop sends its complete current list, so an
     * address it no longer has must disappear. Merging would accumulate stale
     * leases forever and slow every connection down by dialling ghosts.
     *
     * An EMPTY list is a valid instruction meaning "stop dialling" — it is how
     * the desktop turning LAN off reaches a phone connected right now.
     */
    fun save(machineId: String, addresses: List<String>)

    /** Empty when nothing has been pushed yet, or when LAN was turned off. */
    fun load(machineId: String): List<String>

    /** Drops the addresses. Called when a desktop is forgotten. */
    fun forget(machineId: String)
}

/**
 * A `host:port` the phone may dial, split for the socket API.
 *
 * Parsing is deliberately strict and total: a malformed entry is dropped rather
 * than guessed at, because the failure mode of guessing is dialling a stranger.
 */
data class LanAddress(val host: String, val port: Int)

/**
 * Split at the LAST colon so a bracketed IPv6 literal survives.
 *
 * Returns null for anything that is not a plain `host:port` with a port in
 * range. The desktop only ever emits IPv4 (see reachable-addresses.ts), but a
 * parser that trusts its input is one wire change away from a crash.
 */
fun parseLanAddress(raw: String): LanAddress? {
    val trimmed = raw.trim()
    val separator = trimmed.lastIndexOf(':')
    if (separator <= 0 || separator == trimmed.length - 1) return null
    val host = trimmed.substring(0, separator)
    val port = trimmed.substring(separator + 1).toIntOrNull() ?: return null
    if (port < 1 || port > 65535) return null
    if (host.isBlank()) return null
    return LanAddress(host, port)
}
