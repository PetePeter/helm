package com.potatomotato.helm.lan

import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ble.RANK_LAN
import com.potatomotato.helm.data.LanAddressStore
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * LanLinkController — decides WHEN the phone dials, and owns the attempt.
 *
 * [LanLinkSession] knows how to dial; this knows when it is worth doing. The two
 * are split because the "when" is all policy and the "how" is all sockets, and
 * only one of them needs a network to test.
 *
 * WHEN: a Bluetooth link has just come up. That is the moment the phone both
 * knows WHICH desktop it is talking to and has just been told where to reach it
 * (the address push rides the authenticated channel — see
 * MobileAddressAdvertiser). Dialling at any other time would be guessing.
 *
 * It ALSO retries on a backoff whenever LAN does not itself own the link,
 * Bluetooth-owned or offline alike (see [scheduleRetry]). Pausing while
 * Bluetooth held the link stranded phones on Bluetooth for hours: the one
 * Bluetooth-triggered dial usually ran before wifi was up. The backoff caps at
 * a minute, which is the whole battery cost of that.
 *
 * It also dials when a Wi-Fi/Ethernet network appears ([NetworkWatcher]),
 * debounced so a burst of callbacks makes one attempt, and on link-service
 * start ([resume]) whatever the Bluetooth preference.
 *
 * The Bluetooth link is NOT torn down on success. It stays attached at its lower
 * rank so that LAN dropping is an instant handover rather than a reconnect —
 * see HelmLink's transports map.
 */
class LanLinkController(
    private val addresses: LanAddressStore,
    private val dialer: LanLinkSession.Dialer = tcpDialer(),
    /** Runs the blocking pump. Injected so a test never needs a thread pool. */
    private val runBlocking: (() -> Unit) -> Unit = { body -> Thread(body, "helm-lan").start() },
    /**
     * Runs a socket write. Injected so a test can observe the deferral. The
     * default is a single writer thread: Android forbids network I/O on the
     * main thread, and the app's calls arrive there — the transport must
     * absorb the caller's thread exactly as the BLE queue does.
     */
    runWrite: ((() -> Unit) -> Unit)? = null,
    /**
     * Delayed execution for the redial curve. Injected so a test can step the
     * schedule by hand; the default is a daemon thread, matching [runBlocking].
     */
    private val schedule: (delayMs: Long, action: () -> Unit) -> Unit =
        { delayMs, action -> Thread({ Thread.sleep(delayMs); action() }, "helm-lan-retry").apply { isDaemon = true }.start() },
    /**
     * Whether the user is letting the network carry the link — false under the
     * Bluetooth-only setting. Read at each decision rather than captured, so a
     * change takes effect on the next dial without re-wiring anything.
     *
     * Defaults to true: a build that never wires the setting dials as before.
     */
    private val allowDial: () -> Boolean = { true },
    /** Connectivity callbacks; null in tests that are not about them. */
    private val network: NetworkWatcher? = null,
    private val log: (String) -> Unit = {},
) {
    private companion object {
        const val RETRY_MIN_MS = 15_000L
        const val RETRY_MAX_MS = 60_000L
        /** Lets a burst of callbacks (available, then addresses) settle into one dial. */
        const val NETWORK_SETTLE_MS = 2_000L
    }

    private val lock = Any()
    @Volatile private var session: LanLinkSession? = null

    /** True while a dial is in flight, so stacked triggers make one attempt. */
    private var dialing = false

    /** The desktop the last dial was for — who a redial is for. */
    @Volatile private var lastMachineId: String? = null

    private var retryPending = false
    private var retryDelayMs = RETRY_MIN_MS
    @Volatile private var stopped = false
    private var networkDialPending = false

    private val writer: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "helm-lan-writes").apply { isDaemon = true }
        }
    }
    private val runWrite: (() -> Unit) -> Unit =
        runWrite ?: { body -> writer.execute(body) }

    init {
        network?.start(::onNetworkChanged)
    }

    /** True while a LAN connection is up and carrying the link. */
    val connected: Boolean get() = session?.connected == true

    /**
     * Try to reach [machineId] over the network.
     *
     * A no-op when a LAN link is already up or a dial is already in flight:
     * the desktop refuses a second link from the same phone anyway, and two
     * phone-side sockets would race each other for the rank — the loser's
     * teardown detaching the winner's link was a real flap on hardware.
     *
     * Returns true when this call brought a LAN link up. The controller holds
     * ONE session, so callers walking several desktops stop at the first true.
     */
    fun tryConnect(machineId: String): Boolean {
        // Quit can race a queued startup/retry dial; a stopped controller
        // must never open a socket nobody will close.
        if (stopped) return false
        if (!allowDial()) {
            // Remembered so switching back to Auto has a desktop to redial —
            // but never over one already chosen.
            if (lastMachineId == null) lastMachineId = machineId
            log("not dialling: the network is switched off by preference")
            return false
        }
        val lan = dial(machineId)
        if (lan == null) {
            // A failed attempt is retried later — but never when there is
            // nothing to dial, which only a fresh address push can change.
            if (addresses.load(machineId).isNotEmpty()) scheduleRetry()
            return false
        }

        runBlocking {
            try {
                lan.pump()
            } finally {
                // Releasing only THIS rank is what lets Bluetooth — still
                // attached below — resume the instant this ends.
                endIfCurrent(lan)
            }
        }
        return true
    }

    private fun dial(machineId: String): LanLinkSession? {
        synchronized(lock) {
            if (dialing || session?.connected == true) return null
            dialing = true
        }
        try {
            val known = addresses.load(machineId)
            if (known.isEmpty()) return null
            // Recorded only for a desktop actually dialled: a trigger that
            // short-circuits above must not steal the redial target from the
            // desktop the live link belongs to.
            lastMachineId = machineId

            val lan = LanLinkSession(
                dialer = dialer,
                onBytes = { bytes -> HelmLink.publishInbound(RANK_LAN, bytes) },
                onStateChange = { state ->
                    // Only ever reports on its OWN rank. Whether that is the link
                    // the phone is using is HelmLink's decision, not this one's.
                    HelmLink.publishState(RANK_LAN, state.toLinkState())
                },
                log = log,
            )

            // The session keeps the connection; a second handle to it here would
            // be a way to close it behind the session's back.
            if (lan.connect(known) == null) return null
            // Attached AFTER the socket is open, never before: a rank that is
            // registered but cannot carry bytes would silently swallow every send.
            synchronized(lock) {
                session = lan
                HelmLink.attach(
                    rank = RANK_LAN,
                    send = { data -> runWrite { lan.send(data) } },
                    pending = { lan.pendingBytes },
                )
            }
            retryDelayMs = RETRY_MIN_MS
            HelmLink.publishState(RANK_LAN, LinkState.Linked)
            log("LAN link is up; it now carries the link")
            return lan
        } finally {
            synchronized(lock) { dialing = false }
        }
    }

    /**
     * Tear [lan] down only if it is still the current session. Its pump can
     * unwind AFTER a fresher dial has already taken over — releasing the rank
     * then would detach a live link, whose next write fails.
     */
    private fun endIfCurrent(lan: LanLinkSession) {
        synchronized(lock) {
            if (session !== lan) return
            session = null
            HelmLink.detachRank(RANK_LAN)
            log("LAN link ended; Bluetooth resumes if it is still up")
        }
        // A phone whose only path was this socket has no link event coming to
        // re-trigger a dial — the redial loop is that event.
        scheduleRetry()
    }

    /**
     * Redial later, and only when it can matter. While another transport
     * carries the link the attempt is postponed rather than made: Bluetooth
     * being up means the next address push dials better than a timer would,
     * and away from home a quiet timer is the whole cost.
     */
    private fun scheduleRetry() {
        if (lastMachineId == null) return
        if (retryPending || stopped) return
        retryPending = true
        val delay = retryDelayMs
        retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
        schedule(delay) {
            retryPending = false
            if (stopped) return@schedule
            // Read at fire time: a later dial may have linked another desktop.
            val machineId = lastMachineId ?: return@schedule
            dropIfOrphaned()
            if (connected) {
                scheduleRetry()
                return@schedule
            }
            if (HelmLink.owner.value != null) log("retry: dialing while BLE-owned")
            else log("retry: dialing while offline")
            tryConnect(machineId)
        }
    }

    /**
     * A Wi-Fi/Ethernet network appeared or changed addresses. Debounced: the
     * system reports available-then-link-properties in a burst, and each must
     * not become its own socket.
     */
    fun onNetworkChanged() {
        synchronized(lock) {
            if (stopped || networkDialPending || lastMachineId == null) return
            networkDialPending = true
        }
        schedule(NETWORK_SETTLE_MS) {
            synchronized(lock) { networkDialPending = false }
            val machineId = lastMachineId ?: return@schedule
            if (stopped) return@schedule
            dropIfOrphaned()
            if (connected) return@schedule
            log("network change: dialing")
            retryDelayMs = RETRY_MIN_MS
            tryConnect(machineId)
        }
    }

    /**
     * The link service (re)started. Dials every paired desktop regardless of
     * Bluetooth: with Bluetooth off by preference nothing else would. Also
     * recovers a socket the previous service orphaned by clearing HelmLink.
     * Stops at the first desktop that links: there is one session to hold.
     */
    fun resume(machineIds: Collection<String>) {
        if (stopped) return
        dropIfOrphaned()
        retryDelayMs = RETRY_MIN_MS
        for (machineId in machineIds) if (tryConnect(machineId)) return
    }

    /**
     * A live session whose rank is no longer registered carries nothing, yet
     * blocks every dial as "already connected". Close it so the phone redials.
     */
    private fun dropIfOrphaned() {
        val orphan = synchronized(lock) {
            val current = session ?: return
            if (HelmLink.isAttached(RANK_LAN)) return
            session = null
            current
        }
        log("LAN socket was orphaned (rank detached); closing it to redial")
        orphan.close()
    }

    /** Drop any LAN link. Bluetooth takes over again on its own. */
    fun stop() {
        stopped = true
        network?.stop()
        closeSession()
    }

    /**
     * The user allowed or forbade the network (the Bluetooth-only setting).
     *
     * Forbidding DROPS a live socket rather than letting it run until it fails
     * on its own: the setting says which pipe is in use, and one that keeps
     * carrying traffic after being switched off makes the readout a lie.
     * Allowing redials the desktop the last attempt was for — without it the
     * user would have to wait for a Bluetooth reconnect to get the network back.
     *
     * Distinct from [stop], which is teardown and never resumes.
     */
    fun applyPreference(allowed: Boolean) {
        if (stopped) return
        if (!allowed) {
            log("the network was switched off by preference; dropping any LAN link")
            closeSession()
            return
        }
        val machineId = lastMachineId ?: return
        retryDelayMs = RETRY_MIN_MS
        tryConnect(machineId)
    }

    /** Close the live session, if any, and release the rank. Never throws. */
    private fun closeSession() {
        val open = synchronized(lock) {
            val current = session ?: return
            session = null
            current
        }
        open.close()
        HelmLink.detachRank(RANK_LAN)
    }
}

private fun LanLinkState.toLinkState(): LinkState = when (this) {
    LanLinkState.Idle -> LinkState.Disconnected
    LanLinkState.Dialling -> LinkState.Connecting
    LanLinkState.Connected -> LinkState.Linked
}

/**
 * A real TCP dialler.
 *
 * The connect timeout is short on purpose: away from home EVERY address in the
 * list is unreachable, and the user is waiting on a Bluetooth link that already
 * works. Failing fast costs nothing; a default connect timeout would stall the
 * attempt for the better part of a minute.
 */
fun tcpDialer(
    connectTimeoutMs: Int = 1_500,
    /**
     * More than twice the desktop's 15s ping interval: a link that has heard
     * nothing for this long is dead, and must drop to Bluetooth now rather than
     * when TCP gives up ten-plus minutes later.
     */
    readTimeoutMs: Int = 45_000,
): LanLinkSession.Dialer =
    LanLinkSession.Dialer { host, port ->
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
        // Helm's frames are small and chatty during a handshake; Nagle would add
        // latency to every one of them for no benefit.
        socket.tcpNoDelay = true
        socket.soTimeout = readTimeoutMs
        socket.keepAlive = true
        object : LanLinkSession.Connection {
            override val input = socket.getInputStream()
            override val output = socket.getOutputStream()
            override fun close() = socket.close()
        }
    }
