package com.potatomotato.helm.ble

import com.potatomotato.helm.log.HelmLog

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
    private val log: (String) -> Unit = HelmLog.port(HelmLog.BLE),
    /**
     * Wall clock, so a disconnect can report HOW LONG the link lasted. That
     * number is the whole shape of the churn — 13 to 40 seconds, over and over —
     * and a duration distinguishes a supervision timeout from a deliberate
     * teardown far faster than a status code alone.
     */
    private val now: () -> Long = System::currentTimeMillis,
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

    /** When the current central connected, for the lifetime in the drop line. */
    private var connectedAt = 0L

    /** Set when THIS session asked for the disconnect, so "who hung up" is exact. */
    private var disconnectRequested = false

    /** Chunk counters for the current connection. Sizes and counts only. */
    private var chunksSent = 0L
    private var chunksReceived = 0L

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
        log("stopping the link session")
        centralAddress?.let {
            disconnectRequested = true
            safely("disconnect") { peripheral.disconnect(it) }
        }
        safely("stopAdvertising") { peripheral.stopAdvertising() }
        resetLink()
        transitionTo(LinkState.Disconnected)
    }

    /** Restart advertising on demand when the user explicitly starts pairing. */
    fun forcePairingMode() {
        if (!running) return
        centralAddress?.let {
            disconnectRequested = true
            safely("disconnect for pairing") { peripheral.disconnect(it) }
        }
        safely("stopAdvertising for pairing") { peripheral.stopAdvertising() }
        resetLink()
        advertise()
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
        HelmLog.d(HelmLog.BLE) {
            "queueing ${message.size} bytes as ${chunks.size} chunks of $chunkSize; " +
                "${outbound.size} were already waiting"
        }
        outbound.addAll(chunks)
        drain()
    }

    /** Bytes still waiting for a notification slot. Test and diagnostics hook. */
    val pendingChunks: Int get() = outbound.size

    // ---- events from the peripheral ---------------------------------------

    fun onAdvertiseStarted() {
        retryDelayMs = RETRY_MIN_MS
        log("advertising")
        if (centralAddress == null) transitionTo(LinkState.Advertising)
    }

    fun onAdvertiseFailed(reason: String) {
        log("advertising failed: $reason")
        transitionTo(LinkState.Disconnected)
        scheduleRetry()
    }

    fun onCentralConnected(address: String, status: Int = GattStatus.SUCCESS) {
        val current = centralAddress
        if (current != null && current != address) {
            // Never two streams into one reassembler.
            log("refusing a second central $address; $current already holds the link")
            safely("disconnect") { peripheral.disconnect(address) }
            return
        }
        centralAddress = address
        connectedAt = now()
        disconnectRequested = false
        log("central $address connected, status ${GattStatus.describe(status)}")
        // Android keeps advertising through a connection; stop so a second
        // central is never invited in the first place.
        safely("stopAdvertising") { peripheral.stopAdvertising() }
        transitionTo(LinkState.Connecting)
    }

    fun onMtuChanged(address: String, mtu: Int) {
        if (address != centralAddress) return
        chunkSize = BleFraming.chunkSizeForMtu(mtu)
        log("MTU negotiated to $mtu, so a chunk carries $chunkSize bytes")
    }

    /** The central enabled notifications on TX: the link is usable both ways. */
    fun onTxSubscribed(address: String) {
        if (address != centralAddress) return
        log("central $address subscribed to TX; the link is usable both ways")
        transitionTo(LinkState.Linked)
        drain()
    }

    fun onTxUnsubscribed(address: String) {
        if (address != centralAddress) return
        log("central $address unsubscribed from TX after ${millisLinked()}ms")
        transitionTo(LinkState.Connecting)
    }

    fun onRxWrite(address: String, chunk: ByteArray) {
        if (address != centralAddress) {
            log("ignoring a write from $address, which does not hold the link")
            return
        }
        chunksReceived++
        HelmLog.v(HelmLog.BLE) { "rx chunk #$chunksReceived, ${chunk.size} bytes" }
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

    /**
     * The link ended. THE most important line this app logs.
     *
     * It reports the Android status code, who hung up, how long the link lasted
     * and what was still in flight — because the observed failure is a link that
     * dies every 13 to 40 seconds forever, and none of those four facts were
     * recoverable from either end before this.
     */
    fun onCentralDisconnected(address: String, status: Int = GattStatus.SUCCESS) {
        if (address != centralAddress) {
            log("ignoring a disconnect from $address, which does not hold the link")
            return
        }
        val closer = if (disconnectRequested) GattStatus.Closer.PHONE else GattStatus.closerOf(status)
        log(
            "central $address DISCONNECTED after ${millisLinked()}ms" +
                ", status ${GattStatus.describe(status)}" +
                ", closed by $closer" +
                ", state was $state" +
                ", $chunksSent chunks out / $chunksReceived in" +
                ", ${outbound.size} still queued",
        )
        resetLink()
        if (running) advertise() else transitionTo(LinkState.Disconnected)
    }

    /** How long the current central has held the link. 0 when none has. */
    private fun millisLinked(): Long = if (connectedAt == 0L) 0L else now() - connectedAt

    // ---- internals --------------------------------------------------------

    private fun drain() {
        if (state != LinkState.Linked || awaitingNotificationAck) return
        val chunk = outbound.removeFirstOrNull() ?: return
        awaitingNotificationAck = true
        chunksSent++
        HelmLog.v(HelmLog.BLE) { "tx chunk #$chunksSent, ${chunk.size} bytes, ${outbound.size} left" }
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
        connectedAt = 0L
        disconnectRequested = false
        chunksSent = 0
        chunksReceived = 0
        chunkSize = BleFraming.MIN_CHUNK_BYTES
        outbound.clear()
        awaitingNotificationAck = false
        // A fresh sequence counter per connection: the peer's reassembler is
        // also new, and carrying the old count across would read as a gap.
        chunker = BleChunker()
    }

    private fun transitionTo(next: LinkState) {
        if (state == next) return
        log("link state $state -> $next")
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
