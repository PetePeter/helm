package com.potatomotato.helm.ble

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
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
     * Inbound bytes, ONE QUEUE PER TRANSPORT — not one shared stream.
     *
     * It was shared once, and that was a hardware bug: a 55KB reply still
     * draining over Bluetooth when LAN took the link kept arriving, and every
     * chunk was funnelled into the channel that had just been built for the LAN
     * handshake. Sealed with the OLD session's keys, those frames failed
     * authentication and the link flapped. A session belongs to one transport
     * (see [owner]), so its bytes do too: the queue dies with the transport in
     * [detachRank], and a retired transport's unread tail can never be read as
     * the next channel's first frame.
     *
     * Each is a Channel, not a SharedFlow, for the HELLO race: a SharedFlow
     * buffers only for collectors it already has, so the desktop's HELLO —
     * sent the instant it accepts the transport, before the pipe above has
     * attached its collector — vanished. A channel holds the message until a
     * collector takes it.
     */
    private val inboundByRank = mutableMapOf<Int, Channel<ByteArray>>()

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
     *
     * Guarded by [lock]: Bluetooth mutates its entry on a binder thread, LAN on
     * its dial and pump threads, while sends arrive from whichever thread the
     * channel lives on. An unsynchronised TreeMap answered that with
     * ConcurrentModificationException — a null-message error the channel could
     * only report as "link write failed", flapping the link on every upgrade.
     */
    private val transports = sortedMapOf<Int, Attached>()
    private val lock = Any()

    private val _owner = MutableStateFlow<Int?>(null)

    /**
     * Run SYNCHRONOUSLY the instant ownership moves, before [attach] returns.
     *
     * This is not the same thing as collecting [owner], and the difference is a
     * bug found on real hardware. The peer sends its HELLO the moment it accepts
     * the new transport, and the new transport starts pumping bytes immediately
     * — so a listener that merely observes a flow has not run yet. The OLD
     * channel's collector is still attached, eats the new transport's HELLO
     * (the queue is consume-once, so it is gone for good), and ANSWERS it with
     * the old session's keys down the new socket. The peer reports a confirm-MAC
     * failure and the link never forms.
     *
     * Whoever owns the channel above installs this and rebuilds here. Bytes that
     * arrive in the meantime simply wait in the queue, which is what an UNLIMITED
     * channel is for.
     *
     * Fired on a change of EITHER value, because both mean the same thing to the
     * layer above: the session it was holding is no longer the session on the
     * wire.
     */
    internal var onLinkChanged: ((owner: Int?, state: LinkState) -> Unit)? = null

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

    private data class Attached(
        val send: (ByteArray) -> Unit,
        val state: LinkState,
        val pending: () -> Long,
    )

    /**
     * Register a transport of [rank]. Returns whether it currently OWNS the link.
     *
     * [pending] is the transport's own answer to "how many bytes have I taken
     * but not yet put on the wire" — see [pendingBytes]. It defaults to nothing
     * pending, which is the right answer for any transport whose send blocks
     * until the bytes are gone.
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
    internal fun attach(
        rank: Int,
        // BEFORE [send], so that [send] is the trailing lambda every call site
        // already writes it as.
        pending: () -> Long = { 0L },
        send: (ByteArray) -> Unit,
    ): Boolean = synchronized(lock) {
        inboundByRank.getOrPut(rank) { Channel(Channel.UNLIMITED) }
        transports[rank] = Attached(send, transports[rank]?.state ?: LinkState.Disconnected, pending)
        republish()
        holderRank == rank
    }

    /**
     * Release a transport. A no-op if it was never attached.
     *
     * Safe to call late: a BLE link displaced by LAN still eventually closes, and
     * because ranks are addressed individually that teardown cannot touch the
     * link that replaced it.
     */
    internal fun detachRank(rank: Int) = synchronized(lock) {
        // The queue dies with the transport: a finished session's unread tail
        // is garbage, not the next channel's first frame.
        inboundByRank.remove(rank)?.cancel()
        if (transports.remove(rank) == null) return
        republish()
    }

    /**
     * Whether [rank] is registered at all. A transport can outlive its entry —
     * the link service's teardown clears the map while a LAN socket is still
     * open — and its owner must be able to notice that orphaning.
     */
    internal fun isAttached(rank: Int): Boolean = synchronized(lock) { transports.containsKey(rank) }

    /** Which rank currently owns the link, or null when nothing is attached. */
    internal val holderRank: Int? get() = synchronized(lock) { transports.keys.lastOrNull() }

    /** False when the link is down; the caller decides whether that matters. */
    fun send(message: ByteArray): Boolean {
        // Read the entry directly rather than looking up `holderRank`: a sorted
        // map THROWS on a null key where a hash map would answer null, so an
        // empty map is a crash and not a "no link" — see republish. The entry is
        // taken under the lock but SENT outside it — a send may block on the
        // radio or the socket, and the map must never wait for the wire.
        val holder = synchronized(lock) {
            val current = transports.entries.lastOrNull()?.value ?: return false
            if (current.state != LinkState.Linked) return false
            current
        }
        holder.send(message)
        return true
    }

    /**
     * How many bytes the owning transport has accepted but not yet put on the
     * wire. Zero when nothing is attached, or when the owner flushes as it sends.
     *
     * WHY THIS IS PUBLIC: [send] is fire-and-forget over Bluetooth — it queues
     * and returns — so a caller streaming a file learns nothing from its own
     * return values about how far the file has actually got. This is the only
     * honest answer available without a per-slice ack from the desktop, which
     * this link deliberately does not have (round trips are its expensive part).
     * Subtract it from what you handed over and you have what has really gone.
     */
    val pendingBytes: Long
        get() {
            // Read the entry under the lock but ASK outside it, exactly as [send]
            // does: a transport's own monitor is below this one (BLE reports
            // inbound bytes from inside its lock), so calling into it while
            // holding this lock is the two orderings that deadlock.
            val holder = synchronized(lock) { transports.entries.lastOrNull()?.value } ?: return 0L
            return holder.pending()
        }

    /**
     * Report a transport's own state. What the UI shows is the state of whichever
     * transport currently owns the link — derived, never raced for: two
     * transports writing one flag would flap between "Linked" and "Advertising"
     * depending on which spoke last.
     */
    internal fun publishState(rank: Int, next: LinkState) = synchronized(lock) {
        val existing = transports[rank] ?: return
        transports[rank] = existing.copy(state = next)
        republish()
    }

    /** Caller holds [lock]. */
    private fun republish() {
        val holder = transports.entries.lastOrNull()
        val moved = holder?.key != _owner.value
        if (moved) {
            _owner.value = holder?.key
        }
        val state = holder?.value?.state ?: LinkState.Disconnected
        val changed = moved || state != _state.value
        _state.value = state
        // LAST, and synchronously: the values above must already be correct when
        // the channel is rebuilt, and the rebuild must finish before the caller
        // starts pumping the new transport's bytes.
        if (changed) onLinkChanged?.invoke(holder?.key, state)
    }

    /**
     * Bytes that arrived on [rank]'s transport. Dropped when that transport is
     * not attached: bytes from a transport nobody owns belong to no session.
     */
    internal fun publishInbound(rank: Int, message: ByteArray) {
        // UNLIMITED upstream of a collector is bounded by the radio itself —
        // GATT cannot notify faster than the stack acks the last chunk.
        synchronized(lock) { inboundByRank[rank] }?.trySend(message)
    }

    /** The bytes of [rank]'s transport, for the channel bound to it. */
    internal fun inboundFor(rank: Int): Flow<ByteArray> =
        synchronized(lock) { inboundByRank[rank] }?.receiveAsFlow() ?: emptyFlow()

    internal fun detach() = synchronized(lock) {
        transports.clear()
        // Drained UNCONDITIONALLY, not merely when the owner changed: tearing
        // the service down with nothing attached still has to discard whatever
        // the link produced, or those frames greet the next handshake.
        inboundByRank.values.forEach { it.cancel() }
        inboundByRank.clear()
        republish()
    }
}
