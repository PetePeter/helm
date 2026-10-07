package com.potatomotato.helm.link

import com.potatomotato.helm.ble.LinkScheduler
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * LinkEnergyPolicy — which radios are worth powering right now.
 *
 * WHY this exists: the phone used to keep everything energised all the time. A
 * LAN link kept a Bluetooth connection up beside it as a spare, the LAN dialler
 * redialled every minute forever whether or not there was a network to dial
 * over, and with no link at all the peripheral advertised all day. Each was
 * defensible alone; together they were the app's standing battery cost.
 *
 * The rule instead:
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> Searching
 *     Searching --> OnLan: authenticated over LAN
 *     Searching --> OnBluetooth: authenticated over Bluetooth
 *     Searching --> GaveUp: 15 minutes, nothing answered
 *     OnLan --> Searching: link lost
 *     OnBluetooth --> Searching: link lost
 *     GaveUp --> Searching: re-arm
 *     Searching --> Searching: re-arm (fresh 15 minutes)
 * ```
 *
 *  - LINKED: only the transport carrying the link stays up. On LAN, Bluetooth
 *    is off entirely. On Bluetooth, nothing redials LAN in the background.
 *  - SEARCHING: both try, hard — and for a bounded time, which is what makes
 *    trying hard affordable.
 *  - GAVE UP: both stop. Nothing brings the link back but a RE-ARM: the app
 *    being opened, the network or VPN changing, or the user asking.
 *
 * "Linked" means AUTHENTICATED, not merely connected: turning Bluetooth off on
 * the strength of a socket that has not finished its handshake would leave the
 * phone with nothing if that handshake then failed.
 *
 * The cost is stated rather than hidden. Losing a LAN link no longer hands over
 * to Bluetooth instantly — Bluetooth has to advertise and be found again — and
 * a phone that gave up stays unreachable until something re-arms it.
 *
 * This class decides and nothing else. It knows no Android types; the two gates
 * it drives already exist ([com.potatomotato.helm.ble.BleRadioRecovery] and the
 * LAN dialler's retry), and each ANDs this policy with the user's own
 * transport preference.
 */
class LinkEnergyPolicy(
    private val scheduler: LinkScheduler,
    private val searchWindowMs: Long = SEARCH_WINDOW_MS,
    private val log: (String) -> Unit = {},
) {
    enum class Phase(
        /** Whether the Bluetooth peripheral may advertise or hold a link. */
        val bluetooth: Boolean,
        /** Whether the LAN dialler may keep retrying on its own. */
        val lanRetry: Boolean,
    ) {
        Searching(bluetooth = true, lanRetry = true),
        OnLan(bluetooth = false, lanRetry = false),
        OnBluetooth(bluetooth = true, lanRetry = false),
        GaveUp(bluetooth = false, lanRetry = false),
    }

    private val lock = Any()

    /**
     * Starts as [Phase.Searching], and stays there until [start]: a build that
     * never wires the policy keeps both radios working, exactly as before it.
     */
    private val _phase = MutableStateFlow(Phase.Searching)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    /** A search began: the moment to dial LAN once, right now. */
    var onSearchStarted: () -> Unit = {}

    /**
     * Identity of the current search window. [LinkScheduler] cannot cancel, so
     * every new window — and every link — invalidates the give-up already queued.
     */
    private var window = 0

    /** Begin the first search. Called once, when the radios are ready to be driven. */
    fun start() = search("starting")

    /**
     * Which transport carries an AUTHENTICATED link, or null when none does.
     * [owner] is a transport rank ([RANK_LAN] / [RANK_BLE]).
     */
    fun onLink(owner: Int?) {
        val linked = when (owner) {
            RANK_LAN -> Phase.OnLan
            RANK_BLE -> Phase.OnBluetooth
            else -> null
        }
        if (linked != null) {
            synchronized(lock) {
                window++
                if (_phase.value != linked) log("linked; now ${linked.name}")
                _phase.value = linked
            }
            return
        }
        // No link. That is only news to a phase that had one: while searching
        // it is the expected state, and after giving up it changes nothing.
        val hadLink = synchronized(lock) { _phase.value == Phase.OnLan || _phase.value == Phase.OnBluetooth }
        if (hadLink) search("the link went")
    }

    /**
     * Something happened that makes trying worthwhile again — the app was
     * opened, the network changed, the user asked. While a link is up this is
     * nothing: there is no search to restart.
     */
    fun rearm(why: String) {
        val linked = synchronized(lock) { _phase.value == Phase.OnLan || _phase.value == Phase.OnBluetooth }
        if (!linked) search(why)
    }

    private fun search(why: String) {
        val opened = synchronized(lock) {
            _phase.value = Phase.Searching
            ++window
        }
        log("searching for ${searchWindowMs / 60_000} min ($why)")
        scheduler.schedule(searchWindowMs) { giveUp(opened) }
        onSearchStarted()
    }

    private fun giveUp(opened: Int) = synchronized(lock) {
        if (opened != window || _phase.value != Phase.Searching) return
        log("nothing answered; both radios stand down until something re-arms the search")
        _phase.value = Phase.GaveUp
    }

    companion object {
        /** How long both radios try before standing down. */
        const val SEARCH_WINDOW_MS = 15 * 60 * 1000L
    }
}
