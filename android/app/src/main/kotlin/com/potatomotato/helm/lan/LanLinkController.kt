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
 * It does NOT retry on a schedule. Every Bluetooth link is one attempt, and a
 * refreshed address list is another. Away from home that means one quiet failed
 * connect per link rather than a background loop draining the battery to
 * rediscover that the office wifi still isolates its clients.
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
    private val log: (String) -> Unit = {},
) {
    private val lock = Any()
    @Volatile private var session: LanLinkSession? = null

    /** True while a dial is in flight, so stacked triggers make one attempt. */
    private var dialing = false

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
        val lan = dial(machineId) ?: return

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
                HelmLink.attach(RANK_LAN) { data -> runWrite { lan.send(data) } }
            }
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
    }

    /** Drop any LAN link. Bluetooth takes over again on its own. */
    fun stop() {
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
