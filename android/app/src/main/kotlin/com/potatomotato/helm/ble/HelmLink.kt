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

    /**
     * Every attached transport, by rank, with how it sends and where it has got
     * to. The highest rank present IS the link.
     *
     * A MAP rather than one winner, and that is the whole design. With a single
     * holder, LAN displacing BLE is easy and LAN *dropping* is not: the holder
     * becomes empty and Bluetooth does not resume, because it attached once at
     * startup and nothing re-attaches it. The phone would sit dead until the BLE
     * service happened to cycle. Here a transport going away simply removes its
     * rank and the next one down is already in place — there is no restore path
     * to write, and therefore none to forget to call.
     */
    private val transports = sortedMapOf<Int, Attached>()

    private val _owner = MutableStateFlow<Int?>(null)

    /**
     * Which transport currently owns the link, as a flow.
     *
     * A HANDSHAKE BELONGS TO ONE TRANSPORT. When ownership moves, the peer opens
     * a NEW SecureChannel over the new pipe, so the old session's keys and
     * sequence counters are finished — feeding the new transport's handshake
     * into it would read as corruption. Whoever owns the channel above must
     * therefore tear it down and start again on every change of this value, not
     * merely when the link goes down. See HelmPairing.
     */
    val owner: StateFlow<Int?> = _owner.asStateFlow()

    private data class Attached(val send: (ByteArray) -> Unit, val state: LinkState)

    /**
     * Register a transport of [rank]. Returns whether it currently OWNS the link.
     *
     * Attaching always succeeds — a lower-ranked transport stays registered so it
     * can take over the moment the better one goes. The return value answers a
     * different question: whether this transport's bytes are the ones leaving the
     * phone right now.
     *
     * Ownership is not a lock and the loser is not told: its bytes simply stop
     * being sent, and the desktop retires its end of that transport on its own
     * (see MobileLinkManager's retire grace).
     */
    internal fun attach(rank: Int, send: (ByteArray) -> Unit): Boolean {
        transports[rank] = Attached(send, transports[rank]?.state ?: LinkState.Disconnected)
        republish()
        return holderRank == rank
    }

    /**
     * Release a transport. A no-op if it was never attached.
     *
     * Safe to call late: a BLE link displaced by LAN still eventually closes, and
     * because ranks are addressed individually that teardown cannot touch the
     * link that replaced it.
     */
    internal fun detachRank(rank: Int) {
        if (transports.remove(rank) == null) return
        republish()
    }

    /** Which rank currently owns the link, or null when nothing is attached. */
    internal val holderRank: Int? get() = transports.keys.lastOrNull()

    /** False when the link is down; the caller decides whether that matters. */
    fun send(message: ByteArray): Boolean {
        // Read the entry directly rather than looking up `holderRank`: a sorted
        // map THROWS on a null key where a hash map would answer null, so an
        // empty map is a crash and not a "no link" — see republish.
        val holder = transports.entries.lastOrNull()?.value ?: return false
        if (holder.state != LinkState.Linked) return false
        holder.send(message)
        return true
    }

    /**
     * Report a transport's own state. What the UI shows is the state of whichever
     * transport currently owns the link — derived, never raced for: two
     * transports writing one flag would flap between "Linked" and "Advertising"
     * depending on which spoke last.
     */
    internal fun publishState(rank: Int, next: LinkState) {
        val existing = transports[rank] ?: return
        transports[rank] = existing.copy(state = next)
        republish()
    }

    private fun republish() {
        val holder = transports.entries.lastOrNull()
        if (holder?.key != _owner.value) {
            // The bytes a finished transport left behind belong to a session
            // that is over. Dropping them is what stops them being read as the
            // first frame of the next handshake.
            drainInbound()
            _owner.value = holder?.key
        }
        _state.value = holder?.value?.state ?: LinkState.Disconnected
    }

    private fun drainInbound() {
        while (_inbound.tryReceive().isSuccess) {
            // discarded
        }
    }

    internal fun publishInbound(message: ByteArray) {
        // UNLIMITED upstream of a collector is bounded by the radio itself —
        // GATT cannot notify faster than the stack acks the last chunk.
        _inbound.trySend(message)
    }

    internal fun detach() {
        transports.clear()
        // Drained UNCONDITIONALLY, not merely when the owner changed: tearing
        // the service down with nothing attached still has to discard whatever
        // the link produced, or those frames greet the next handshake.
        drainInbound()
        republish()
    }
}
