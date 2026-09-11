package com.potatomotato.helm.link

import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.crypto.BytePipe
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * [HelmLink] seen as a [BytePipe]. An adapter, and nothing more: the layers
 * above must not know that the bytes arrive over GATT, and P-0741 already did
 * the chunking, MTU sizing and reassembly below.
 */
class HelmLinkPipe(private val scope: CoroutineScope) : BytePipe {
    private var collector: Job? = null
    private var onClose: (() -> Unit)? = null
    private var closed = false

    /**
     * A refused notification discards the rest of that message and produces no
     * error frame, so a send that the link cannot accept must surface as a
     * failure here — otherwise the peer simply waits forever.
     */
    override fun write(data: ByteArray) {
        check(!closed) { "link is closed" }
        check(HelmLink.send(data)) { "link refused the write" }
    }

    override fun onData(handler: (ByteArray) -> Unit) {
        collector?.cancel()
        collector = scope.launch { HelmLink.inbound.collect(handler) }
    }

    override fun onClose(handler: () -> Unit) {
        onClose = handler
    }

    override fun close() {
        if (closed) return
        closed = true
        collector?.cancel()
        collector = null
        onClose?.invoke()
    }
}

/** [ChannelScheduler] over a coroutine scope — the handshake timeout's clock. */
class CoroutineScheduler(private val scope: CoroutineScope) : ChannelScheduler {
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val job = scope.launch {
            delay(delayMs)
            action()
        }
        return Cancellable { job.cancel() }
    }
}
