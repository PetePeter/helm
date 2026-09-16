package com.potatomotato.helm.ble

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * HelmLink — the duplex byte stream, as the layers above see it.
 *
 * The service owns the radio but must not be the thing SecureChannel talks to:
 * a bound-service handle would drag Android lifecycle into every layer above.
 * This is the seam instead — process-scoped, because there is exactly one radio
 * and exactly one link.
 *
 * Whole messages only over BLE, where chunking lives below in [BleLinkSession].
 * Over LAN the bytes arrive as the stream segments them, which is equally fine:
 * SecureChannel accumulates and splits on its own length prefix either way.
 *
 * TWO TRANSPORTS, ONE LINK (P-0752). Bluetooth works anywhere and is slow; LAN
 * works at home and is not. Both can be live at once, so ownership is RANKED
 * and the higher rank holds the link — the same rule the desktop applies from
 * its end, so the two converge without negotiating. See [attach].
 */
object HelmLink {
    private val _state = MutableStateFlow(LinkState.Disconnected)

    /** The link as the UI shows it. */
    val state: StateFlow<LinkState> = _state.asStateFlow()

    /**
     * A Channel, not a SharedFlow: a SharedFlow buffers only for collectors it
     * already has, so a message published before anyone subscribed vanished.
     * That was the HELLO race — the central subscribes on a binder thread and
     * the pipe above attaches a moment later, and a lost HELLO cost a 20s
     * handshake timeout. A channel holds the message until a collector takes
     * it; late subscribers drain whatever the link produced in the gap.
     */
    private val _inbound = Channel<ByteArray>(Channel.UNLIMITED)

    /** Whole messages from Helm, already reassembled. */
    val inbound: Flow<ByteArray> = _inbound.receiveAsFlow()

    /** The transport that currently owns the link, and how it sends. */
    private var holder: Holder? = null

    private data class Holder(val rank: Int, val send: (ByteArray) -> Unit)

    /**
     * Take the link for a transport of [rank], if nothing better holds it.
     *
     * Higher wins and EQUAL LOSES: a transport re-attaching at its own rank must
     * not displace itself mid-stream. Returns whether the caller now owns it, so
     * a loser can close its own connection rather than sit half-attached.
     *
     * Ownership is not a lock: the incumbent is not told, because there is
     * nothing for it to do. Its bytes simply stop being sent, and the desktop
     * retires its end of that transport on its own (see MobileLinkManager's
     * retire grace).
     */
    internal fun attach(rank: Int, send: (ByteArray) -> Unit): Boolean {
        val current = holder
        if (current != null && current.rank >= rank) return false
        holder = Holder(rank, send)
        return true
    }

    /**
     * Release the link IF this rank still holds it.
     *
     * The rank check is what makes a losing transport's later teardown safe: a
     * BLE link displaced by LAN still eventually closes, and a bare release
     * would take the LAN link down with it.
     */
    internal fun detachRank(rank: Int) {
        if (holder?.rank != rank) return
        holder = null
        _state.value = LinkState.Disconnected
    }

    /** Which rank owns the link, or null when nothing does. Diagnostics only. */
    internal val holderRank: Int? get() = holder?.rank

    /** False when the link is down; the caller decides whether that matters. */
    fun send(message: ByteArray): Boolean {
        val send = holder?.send ?: return false
        if (_state.value != LinkState.Linked) return false
        send(message)
        return true
    }

    internal fun publishState(next: LinkState) {
        _state.value = next
    }

    internal fun publishInbound(message: ByteArray) {
        // UNLIMITED upstream of a collector is bounded by the radio itself —
        // GATT cannot notify faster than the stack acks the last chunk.
        _inbound.trySend(message)
    }

    internal fun detach() {
        holder = null
        _state.value = LinkState.Disconnected
        // Frames a dead link left unconsumed are garbage to the next one: the
        // peer's sequence counters start over, so delivering them would read
        // as corruption. Drop them rather than leak them into a new handshake.
        while (_inbound.tryReceive().isSuccess) {
            // discarded
        }
    }
}
