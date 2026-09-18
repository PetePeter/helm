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
 * It ALSO retries on a backoff, but ONLY while nothing else carries the link
 * (see [scheduleRetry]). The Bluetooth-triggered attempt alone strands a phone
 * whose ONLY path is the network: away from home over a VPN there is no
 * Bluetooth link coming to re-trigger the dial, so one dropped TCP connection
 * used to be permanent. A phone whose Bluetooth link IS up is never retried —
 * the next address push does that job better, and a background loop would drain
 * the battery rediscovering that the office wifi still isolates its clients.
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
    private val log: (String) -> Unit = {},
) {
    private companion object {
        const val RETRY_MIN_MS = 15_000L
        const val RETRY_MAX_MS = 60_000L
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

    private val writer: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "helm-lan-writes").apply { isDaemon = true }
        }
    }
    private val runWrite: (() -> Unit) -> Unit =
        runWrite ?: { body -> writer.execute(body) }

    /** True while a LAN connection is up and carrying the link. */
    val connected: Boolean get() = session?.connected == true

    /**
     * Try to reach [machineId] over the network.
     *
     * A no-op when a LAN link is already up or a dial is already in flight:
     * the desktop refuses a second link from the same phone anyway, and two
     * phone-side sockets would race each other for the rank — the loser's
     * teardown detaching the winner's link was a real flap on hardware.
     */
    fun tryConnect(machineId: String) {
        lastMachineId = machineId
        // Remembered FIRST, so switching back to Auto has a desktop to redial.
        if (!allowDial()) {
            log("not dialling: the network is switched off by preference")
            return
        }
        val lan = dial(machineId)
        if (lan == null) {
            // A failed attempt is retried later — but never when there is
            // nothing to dial, which only a fresh address push can change.
            if (addresses.load(machineId).isNotEmpty()) scheduleRetry()
            return
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
    }

    private fun dial(machineId: String): LanLinkSession? {
        synchronized(lock) {
            if (dialing || session?.connected == true) return null
            dialing = true
        }
        try {
            val known = addresses.load(machineId)
            if (known.isEmpty()) return null

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
        val machineId = lastMachineId ?: return
        if (retryPending || stopped) return
        retryPending = true
        val delay = retryDelayMs
        retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
        schedule(delay) {
            retryPending = false
            if (stopped) return@schedule
            when {
                connected -> scheduleRetry()
                HelmLink.state.value == LinkState.Linked -> scheduleRetry()
                else -> tryConnect(machineId)
            }
        }
    }

    /** Drop any LAN link. Bluetooth takes over again on its own. */
    fun stop() {
        stopped = true
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
fun tcpDialer(connectTimeoutMs: Int = 1_500): LanLinkSession.Dialer =
    LanLinkSession.Dialer { host, port ->
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
        // Helm's frames are small and chatty during a handshake; Nagle would add
        // latency to every one of them for no benefit.
        socket.tcpNoDelay = true
        object : LanLinkSession.Connection {
            override val input = socket.getInputStream()
            override val output = socket.getOutputStream()
            override fun close() = socket.close()
        }
    }
