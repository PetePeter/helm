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
 * Whole messages only. Chunking lives below, in [BleLinkSession].
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

    /** Installed by [HelmLinkService] while it holds the radio. */
    internal var sender: ((ByteArray) -> Unit)? = null

    /** False when the link is down; the caller decides whether that matters. */
    fun send(message: ByteArray): Boolean {
        val send = sender ?: return false
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
        sender = null
        _state.value = LinkState.Disconnected
        // Frames a dead link left unconsumed are garbage to the next one: the
        // peer's sequence counters start over, so delivering them would read
        // as corruption. Drop them rather than leak them into a new handshake.
        while (_inbound.tryReceive().isSuccess) {
            // discarded
        }
    }
}
