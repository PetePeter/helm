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
    private companion object {
        const val RETRY_MIN_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L

        /**
         * The stack ACKs every notification it accepted. If none arrives within
         * this window the transport is wedged in exactly the way the desktop saw
         * (commit 4f3ace1): no error, no disconnect event, a queue stuck on its
         * first chunk. Treat it as a dropped link rather than wait forever.
         */
        const val ACK_TIMEOUT_MS = 10_000L

        /**
         * How often the central's reality is re-checked while this session
         * claims one. A phone that is only LISTENING has no traffic of its own
         * to notice a silent loss with — the ack watchdog arms only after an
         * outbound chunk — so the one probe available is a look at the radio
         * itself, taken on the same scheduler everything else here defers to.
         */
        const val SUPERVISE_INTERVAL_MS = 15_000L

        /**
         * Pause before re-sending a chunk the stack refused. A refusal is almost
         * always momentary congestion (the notification slot not yet released),
         * and dropping the rest of the record instead leaves a sequence gap the
         * desktop's AEAD check turns into a full link teardown. One retry after a
         * beat is enough to ride that out without holding the queue for long.
         */
        const val CHUNK_RETRY_DELAY_MS = 50L
    }

    /**
     * GATT callbacks arrive on binder threads, sends arrive from whatever
     * coroutine calls [HelmLink.send], retries fire on the scheduler's thread —
     * and the queue below is plain mutable state. One monitor owns all of it;
     * every entry point below takes it, so events interleave at whole-event
     * granularity and never inside a drain.
     */
    private val lock = Any()

    @Volatile
    var state: LinkState = LinkState.Disconnected
        private set

    /** Negotiated payload size. The BLE 4.0 floor until a central raises the MTU. */
    @Volatile
    var chunkSize: Int = BleFraming.MIN_CHUNK_BYTES
        private set

    /** The one central allowed to be connected, or null when nobody is. */
    @Volatile
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

    /**
     * Wire bytes this session has accepted but the stack has not acknowledged —
     * the queue below plus whichever chunk is in flight.
     *
     * Kept as a counter rather than summed on demand because it is READ far more
     * often than it changes: an upload watches it to pace itself (see
     * [HelmLink.pendingBytes]), and walking a deque of thousands of chunks on
     * every poll would be the expensive half of the transfer.
     */
    private var outboundBytes = 0L
    private var inFlightBytes = 0

    /**
     * Identity of the deadline currently armed for the chunk in flight. Each
     * send arms a new one; an ack or a teardown invalidates the old ones, so a
     * stale [LinkScheduler] action can never tear down a healthy link.
     */
    private var ackWatch = 0L

    /** The chunk on the air, kept so a refusal can put it back for one retry. */
    private var inFlightChunk: ByteArray? = null

    /** Whether [inFlightChunk] is already its own retry; a second refusal gives up. */
    private var chunkRetried = false

    /** True while a refused chunk waits out [CHUNK_RETRY_DELAY_MS]; drain holds. */
    private var chunkRetryPending = false

    /** Bumped per connection so a retry scheduled on a dead link no-ops. */
    private var linkEpoch = 0L

    // ---- control ----------------------------------------------------------

    fun start() = synchronized(lock) {
        if (running) return
        running = true
        advertise()
    }

    fun stop() = synchronized(lock) {
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
    fun forcePairingMode() = synchronized(lock) {
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
    fun send(message: ByteArray) = synchronized(lock) {
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
        outboundBytes += chunks.sumOf { it.size.toLong() }
        drain()
    }

    /** Bytes still waiting for a notification slot. Test and diagnostics hook. */
    val pendingChunks: Int get() = synchronized(lock) { outbound.size }

    /**
     * Wire bytes queued or in flight, i.e. accepted here but not yet on the air.
     *
     * This is the BLE half of the link's backpressure contract (see
     * [HelmLink.pendingBytes]). It matters because [send] RETURNS IMMEDIATELY:
     * a caller that measures its own progress by what it has handed over is
     * measuring the queue, not the radio, and over a link that carries a few
     * hundred bytes per notification those are minutes apart.
     */
    val pendingBytes: Long get() = synchronized(lock) { outboundBytes }

    // ---- events from the peripheral ---------------------------------------

    fun onAdvertiseStarted() = synchronized(lock) {
        retryDelayMs = RETRY_MIN_MS
        log("advertising")
        if (centralAddress == null) transitionTo(LinkState.Advertising)
    }

    fun onAdvertiseFailed(reason: String) = synchronized(lock) {
        log("advertising failed: $reason")
        transitionTo(LinkState.Disconnected)
        scheduleRetry()
    }

    fun onCentralConnected(address: String, status: Int = GattStatus.SUCCESS) = synchronized(lock) {
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
        supervise()
    }

    fun onMtuChanged(address: String, mtu: Int) = synchronized(lock) {
        if (address != centralAddress) return
        chunkSize = BleFraming.chunkSizeForMtu(mtu)
        log("MTU negotiated to $mtu, so a chunk carries $chunkSize bytes")
    }

    /** The central enabled notifications on TX: the link is usable both ways. */
    fun onTxSubscribed(address: String) = synchronized(lock) {
        if (address != centralAddress) return
        log("central $address subscribed to TX; the link is usable both ways")
        transitionTo(LinkState.Linked)
        drain()
    }

    fun onTxUnsubscribed(address: String) = synchronized(lock) {
        if (address != centralAddress) return
        log("central $address unsubscribed from TX after ${millisLinked()}ms")
        transitionTo(LinkState.Connecting)
    }

    fun onRxWrite(address: String, chunk: ByteArray) = synchronized(lock) {
        if (address != centralAddress) {
            log("ignoring a write from $address, which does not hold the link")
            return
        }
        chunksReceived++
        HelmLog.v(HelmLog.BLE) { "rx chunk #$chunksReceived, ${chunk.size} bytes" }
        reassembler.push(chunk)
    }

    fun onNotificationSent(address: String, success: Boolean) = synchronized(lock) {
        if (address != centralAddress) return
        awaitingNotificationAck = false
        if (!success) {
            onChunkRefused("notification failed")
            return
        }
        inFlightChunk = null
        chunkRetried = false
        // Acked, so those bytes are no longer pending — counted here rather than
        // at dequeue so "pending" means "not yet on the air", not "not yet tried".
        outboundBytes -= inFlightBytes
        inFlightBytes = 0
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
    fun onCentralDisconnected(address: String, status: Int = GattStatus.SUCCESS) = synchronized(lock) {
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

    /**
     * Ask the radio whether the central this session still remembers is really
     * there. [centralAddress] is an ECHO of the stack's connected list, and the
     * two can disagree: a central that died without an announcement — a wedged
     * disconnect on the peer's stack does exactly this — leaves the echo
     * pointing at nobody. A ghost like that gets promoted straight back into
     * service when LAN releases the link, and nothing else ever surfaces it.
     *
     * The disconnect path is reused wholesale: reset, re-advertise, wait.
     */
    fun verifyCentral() = synchronized(lock) {
        val address = centralAddress ?: return
        if (peripheral.connectedCentrals().any { it == address }) return
        log("central $address is gone from the radio without an announcement; dropping the stale link")
        onCentralDisconnected(address, GattStatus.SUCCESS)
    }

    /**
     * The idle half of liveness. Arms with each central and re-arms while one
     * holds the link; [verifyCentral] decides what the look found.
     */
    private fun supervise() {
        scheduler.schedule(SUPERVISE_INTERVAL_MS) {
            synchronized(lock) {
                if (!running || centralAddress == null) return@schedule
                verifyCentral()
                // Re-arm only while a central is still held: a look that found
                // a ghost has already ended the thing being supervised.
                if (centralAddress != null) supervise()
            }
        }
    }

    // ---- internals --------------------------------------------------------

    private fun drain() {
        if (state != LinkState.Linked || awaitingNotificationAck || chunkRetryPending) return
        val chunk = outbound.removeFirstOrNull() ?: return
        awaitingNotificationAck = true
        inFlightChunk = chunk
        inFlightBytes = chunk.size
        chunksSent++
        HelmLog.v(HelmLog.BLE) { "tx chunk #$chunksSent, ${chunk.size} bytes, ${outbound.size} left" }
        val accepted = safely("notifyTx") { peripheral.notifyTx(chunk) } ?: false
        if (!accepted) {
            // A synchronous refusal never produces an ack callback, so unwind
            // here or the queue stalls forever.
            awaitingNotificationAck = false
            onChunkRefused("notification rejected")
            return
        }
        armAckDeadline()
    }

    /**
     * The stack refused the chunk in flight, synchronously or via a failed
     * `onNotificationSent`. Dropping it would leave a hole in the record — a
     * sequence gap the desktop reads as an AEAD failure and answers by tearing
     * the whole link down — so the chunk goes back to the head of the queue and
     * is retried ONCE after [CHUNK_RETRY_DELAY_MS]. A second refusal means the
     * stack is not just congested: the rest of the message is discarded rather
     * than sent with a hole, and the peer's framing check is the notice.
     */
    private fun onChunkRefused(what: String) {
        val chunk = inFlightChunk
        inFlightChunk = null
        inFlightBytes = 0
        if (chunk != null && !chunkRetried) {
            chunkRetried = true
            chunkRetryPending = true
            // Still counted in outboundBytes: it has not reached the air.
            outbound.addFirst(chunk)
            log("$what; retrying the chunk once in ${CHUNK_RETRY_DELAY_MS}ms")
            val epoch = linkEpoch
            scheduler.schedule(CHUNK_RETRY_DELAY_MS) {
                synchronized(lock) {
                    if (epoch == linkEpoch) {
                        chunkRetryPending = false
                        drain()
                    }
                }
            }
            return
        }
        chunkRetried = false
        log("$what after a retry; discarding ${outbound.size} queued chunks")
        discardOutbound()
    }

    /**
     * Drop everything queued. One place, because the byte counter and the queue
     * going out of step would leave an upload pacing itself against a backlog
     * that no longer exists — i.e. stalled forever.
     */
    private fun discardOutbound() {
        outbound.clear()
        outboundBytes = 0
        inFlightBytes = 0
    }

    /**
     * The stack promises one `onNotificationSent` per accepted notification.
     * Should that callback never come — a central uninstalled mid-write does
     * exactly this — nothing else ever moves, so the deadline below is what
     * turns a silently wedged transport into an ordinary dropped link.
     */
    private fun armAckDeadline() {
        val watch = ++ackWatch
        scheduler.schedule(ACK_TIMEOUT_MS) {
            // synchronized, because this fires on the scheduler's thread, not
            // whichever one was draining when the deadline was armed.
            synchronized(lock) { onAckDeadline(watch) }
        }
    }

    private fun onAckDeadline(watch: Long) {
        if (watch != ackWatch || !awaitingNotificationAck || centralAddress == null) return
        val address = centralAddress ?: return
        log(
            "no notification ack within ${ACK_TIMEOUT_MS}ms; " +
                "treating the transport as dropped, discarding ${outbound.size} queued chunks",
        )
        disconnectRequested = true
        discardOutbound()
        awaitingNotificationAck = false
        ackWatch++
        safely("disconnect after ack timeout") { peripheral.disconnect(address) }
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
        discardOutbound()
        awaitingNotificationAck = false
        inFlightChunk = null
        chunkRetried = false
        chunkRetryPending = false
        linkEpoch++
        // Invalidate any ack deadline still in flight from the dead connection;
        // LinkScheduler has no cancel, so the stale action simply no-ops.
        ackWatch++
        // A fresh sequence counter per connection: the peer's reassembler is
        // also new, and carrying the old count across would read as a gap.
        chunker = BleChunker()
        // And the mirror image: OUR reassembler must forget the old count too,
        // or the peer's fresh chunker starting at zero drops its first message
        // as a sequence gap.
        reassembler.reset()
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

    /**
     * The centrals the RADIO says are connected — the truth [BleLinkSession]'s
     * [centralAddress][BleLinkSession.centralAddress] is only an echo of, and
     * what [verifyCentral][BleLinkSession.verifyCentral] checks it against.
     */
    fun connectedCentrals(): List<String>
}

/** Deferred execution, so advertising backoff is testable without a clock. */
fun interface LinkScheduler {
    fun schedule(delayMs: Long, action: () -> Unit)
}
