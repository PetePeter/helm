package com.potatomotato.helm.ble

/**
 * BleLinkSession — the link lifecycle, with every Android type kept out.
 *
 * WHY it exists separately from [GattServer]: advertising/ownership/backpressure
 * is where the bugs live, and none of it can be tested on a device in CI. The
 * Android classes stay dumb adapters that translate framework callbacks into
 * the events below; everything that decides anything lives here and is tested
 * on the JVM against a fake peripheral.
 *
 * Ownership: exactly one central at a time. Helm is the only central that
 * should ever connect, and a second one arriving mid-link would interleave two
 * byte streams into one reassembler. The newcomer is disconnected.
 *
 * The phone never initiates. On a range loss it returns to advertising and
 * waits, which is the whole of "reconnect" on this side.
 */
class BleLinkSession(
    private val peripheral: GattPeripheral,
    private val scheduler: LinkScheduler,
    private val onMessage: (ByteArray) -> Unit,
    private val onStateChange: (LinkState) -> Unit = {},
    private val log: (String) -> Unit = {},
) {
    /** Advertising retry backoff, mirroring the desktop client's rescan curve. */
    private companion object {
        const val RETRY_MIN_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L
    }

    var state: LinkState = LinkState.Disconnected
        private set

    /** Negotiated payload size. The BLE 4.0 floor until a central raises the MTU. */
    var chunkSize: Int = BleFraming.MIN_CHUNK_BYTES
        private set

    /** The one central allowed to be connected, or null when nobody is. */
    var centralAddress: String? = null
        private set

    private var running = false
    private var retryDelayMs = RETRY_MIN_MS
    private var retryPending = false

    private var chunker = BleChunker()
    private val reassembler = BleReassembler(
        onMessage = { message -> onMessage(message) },
        onDrop = { reason -> log("inbound chunk dropped: $reason") },
    )

    private val outbound = ArrayDeque<ByteArray>()
    private var awaitingNotificationAck = false

    // ---- control ----------------------------------------------------------

    fun start() {
        if (running) return
        running = true
        advertise()
    }

    fun stop() {
        if (!running) return
        running = false
        centralAddress?.let { safely("disconnect") { peripheral.disconnect(it) } }
        safely("stopAdvertising") { peripheral.stopAdvertising() }
        resetLink()
        transitionTo(LinkState.Disconnected)
    }

    /**
     * Queue a whole message for the central. Chunks are emitted one
     * notification at a time; GATT gives no second slot until the stack
     * acknowledges the first.
     */
    fun send(message: ByteArray) {
        val chunks = try {
            chunker.chunk(message, chunkSize)
        } catch (e: IllegalArgumentException) {
            log("refusing to send: ${e.message}")
            return
        }
        outbound.addAll(chunks)
        drain()
    }

    /** Bytes still waiting for a notification slot. Test and diagnostics hook. */
    val pendingChunks: Int get() = outbound.size

    // ---- events from the peripheral ---------------------------------------

    fun onAdvertiseStarted() {
        retryDelayMs = RETRY_MIN_MS
        if (centralAddress == null) transitionTo(LinkState.Advertising)
    }

    fun onAdvertiseFailed(reason: String) {
        log("advertising failed: $reason")
        transitionTo(LinkState.Disconnected)
        scheduleRetry()
    }

    fun onCentralConnected(address: String) {
        val current = centralAddress
        if (current != null && current != address) {
            // Never two streams into one reassembler.
            log("refusing a second central $address; $current already holds the link")
            safely("disconnect") { peripheral.disconnect(address) }
            return
        }
        centralAddress = address
        // Android keeps advertising through a connection; stop so a second
        // central is never invited in the first place.
        safely("stopAdvertising") { peripheral.stopAdvertising() }
        transitionTo(LinkState.Connecting)
    }

    fun onMtuChanged(address: String, mtu: Int) {
        if (address != centralAddress) return
        chunkSize = BleFraming.chunkSizeForMtu(mtu)
    }

    /** The central enabled notifications on TX: the link is usable both ways. */
    fun onTxSubscribed(address: String) {
        if (address != centralAddress) return
        transitionTo(LinkState.Linked)
        drain()
    }

    fun onTxUnsubscribed(address: String) {
        if (address != centralAddress) return
        transitionTo(LinkState.Connecting)
    }

    fun onRxWrite(address: String, chunk: ByteArray) {
        if (address != centralAddress) {
            log("ignoring a write from $address, which does not hold the link")
            return
        }
        reassembler.push(chunk)
    }

    fun onNotificationSent(address: String, success: Boolean) {
        if (address != centralAddress) return
        awaitingNotificationAck = false
        if (!success) {
            // The stack refused the chunk. The message is now unrecoverable at
            // this layer; drop the rest of it rather than sending a hole, and
            // let SecureChannel's own timeout above notice.
            log("notification failed; discarding ${outbound.size} queued chunks")
            outbound.clear()
            return
        }
        drain()
    }

    fun onCentralDisconnected(address: String) {
        if (address != centralAddress) return
        resetLink()
        if (running) advertise() else transitionTo(LinkState.Disconnected)
    }

    // ---- internals --------------------------------------------------------

    private fun drain() {
        if (state != LinkState.Linked || awaitingNotificationAck) return
        val chunk = outbound.removeFirstOrNull() ?: return
        awaitingNotificationAck = true
        val accepted = safely("notifyTx") { peripheral.notifyTx(chunk) } ?: false
        if (!accepted) {
            // A synchronous refusal never produces an ack callback, so unwind
            // here or the queue stalls forever.
            awaitingNotificationAck = false
            log("notification rejected; discarding ${outbound.size} queued chunks")
            outbound.clear()
        }
    }

    private fun advertise() {
        safely("startAdvertising") { peripheral.startAdvertising() }
    }

    private fun scheduleRetry() {
        if (!running || retryPending) return
        retryPending = true
        val delay = retryDelayMs
        retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
        scheduler.schedule(delay) {
            retryPending = false
            if (running && centralAddress == null) advertise()
        }
    }

    private fun resetLink() {
        centralAddress = null
        chunkSize = BleFraming.MIN_CHUNK_BYTES
        outbound.clear()
        awaitingNotificationAck = false
        // A fresh sequence counter per connection: the peer's reassembler is
        // also new, and carrying the old count across would read as a gap.
        chunker = BleChunker()
    }

    private fun transitionTo(next: LinkState) {
        if (state == next) return
        state = next
        try {
            onStateChange(next)
        } catch (e: Exception) {
            log("state observer threw: ${e.javaClass.simpleName}")
        }
    }

    /** BLE errors log and continue; they never take the service down. */
    private fun <T> safely(what: String, action: () -> T): T? =
        try {
            action()
        } catch (e: Exception) {
            log("$what threw ${e.javaClass.simpleName}: ${e.message}")
            null
        }
}

/**
 * The radio, as this session needs it. [GattServer] is the Android
 * implementation; tests use a fake.
 */
interface GattPeripheral {
    fun startAdvertising()
    fun stopAdvertising()

    /** Push one chunk on TX. False means the stack refused it outright. */
    fun notifyTx(chunk: ByteArray): Boolean

    fun disconnect(centralAddress: String)
}

/** Deferred execution, so advertising backoff is testable without a clock. */
fun interface LinkScheduler {
    fun schedule(delayMs: Long, action: () -> Unit)
}
