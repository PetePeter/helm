package com.potatomotato.helm.ble

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

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

    private val _inbound = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)

    /** Whole messages from Helm, already reassembled. */
    val inbound: SharedFlow<ByteArray> = _inbound.asSharedFlow()

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
        _inbound.tryEmit(message)
    }

    internal fun detach() {
        sender = null
        _state.value = LinkState.Disconnected
    }
}
