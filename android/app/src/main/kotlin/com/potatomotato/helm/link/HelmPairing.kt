package com.potatomotato.helm.link

import android.content.Context
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.lan.LanLinkController
import com.potatomotato.helm.data.DeviceKeyStore
import com.potatomotato.helm.data.LanAddressStore
import com.potatomotato.helm.data.PrefsLanAddressStore
import com.potatomotato.helm.data.PairedDesktop
import com.potatomotato.helm.data.PhoneIdentity
import com.potatomotato.helm.data.PrefsUnreadStore
import com.potatomotato.helm.data.PskStore
import com.potatomotato.helm.data.pairedDesktops
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.notify.AndroidNotifications
import com.potatomotato.helm.notify.FileNotificationSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.io.File

/**
 * HelmPairing — where the radio meets the handshake.
 *
 * Process-scoped for the same reason [HelmLink] is: there is exactly one radio,
 * one link and one pairing at a time. It holds no logic of its own — every
 * decision belongs to [PairingController], which is why that class knows nothing
 * about Android and can be tested without a device.
 *
 * ```mermaid
 * graph LR
 *     GATT[BleLinkSession] --> HL[HelmLink<br/>whole messages]
 *     HL --> HP[HelmLinkPipe<br/>BytePipe]
 *     HP --> SC[SecureChannel<br/>responder]
 *     SC --> PC[PairingController<br/>state + PskStore]
 *     PC --> UI[PairingScreen]
 * ```
 */
object HelmPairing {
    private val scope = CoroutineScope(SupervisorJob())

    private var controller: PairingController? = null
    private var pipe: HelmLinkPipe? = null
    private var store: PskStore? = null
    private var lanAddresses: LanAddressStore? = null
    private var lan: LanLinkController? = null
    private var started = false

    /**
     * A LAN address list that arrived before pairing had a desktop to file it
     * under. Drained by [refreshDesktops] the moment one exists.
     */
    private var pendingLanAddresses: List<String>? = null

    private val _desktops = MutableStateFlow<List<PairedDesktop>>(emptyList())

    /**
     * Every desktop this phone holds a key for, live one first.
     *
     * A flow rather than a function the screen calls: which desktop is linked
     * changes with the radio, not with navigation, so a screen that read it once
     * on arrival would show a stale dot for as long as it stayed open.
     */
    val desktops: StateFlow<List<PairedDesktop>> = _desktops.asStateFlow()

    /**
     * What the app talks to once the handshake is done. It sends through [send],
     * so it inherits the rule that nothing leaves the phone before the link is
     * authenticated — there is no second way out.
     */
    val client = HelmClient(send = ::send, scheduler = CoroutineScheduler(scope))

    /** What the pairing screen renders. Idle until the first link comes up. */
    val state: StateFlow<PairingState>
        get() = requireController().state

    /** Called once from [com.potatomotato.helm.HelmApp]. */
    fun init(context: Context) {
        if (started) return
        started = true
        // The notification surface and its stored setting both need a Context, so
        // they are attached here rather than constructed with the client — the
        // same shape as HelmLink.sender. Settings first: the router adopts what
        // the user chose before any alert can arrive to be judged against it.
        client.alerts.useSettings(FileNotificationSettings(File(context.filesDir, NOTIFY_DIRECTORY)))
        client.alerts.port = AndroidNotifications(context)
        // The unread counts, persisted the same late way: the store needs a
        // Context and the client above predates one.
        client.chats.useUnreadStore(PrefsUnreadStore(context))
        val keys = DeviceKeyStore(context)
        store = keys
        // Where the desktop says it can be reached (P-0752). Keyed on the LIVE
        // desktop, because that is the only one that could have sent it — and
        // an address is only ever believed when it arrives over the
        // authenticated channel this callback hangs off.
        val addresses = PrefsLanAddressStore(context)
        lanAddresses = addresses
        lan = LanLinkController(
            addresses = addresses,
            log = { message -> HelmLog.i(HelmLog.WIRE, message) },
        )
        client.onLanAddresses = { pushed ->
            val desktopId = (controller?.state?.value as? PairingState.Linked)?.desktopId
            if (desktopId == null) {
                // HELD, NOT DROPPED. The desktop advertises its addresses the
                // moment IT adopts the link, which during a first pairing is
                // before this phone's user has tapped "They match" — so the
                // list routinely lands while the state is still Comparing and
                // there is no desktop id to file it under yet.
                //
                // This used to be discarded, on the reasoning that the push
                // repeats. It does not: it repeats on the desktop's `online`
                // event, i.e. the NEXT reconnect. So a freshly paired phone
                // could finish pairing having never learned an address, and the
                // first walk out of Bluetooth range dropped it to nothing with
                // no LAN to fall back to. Observed on real hardware, minutes
                // after a successful pairing.
                pendingLanAddresses = pushed
                HelmLog.i(HelmLog.WIRE, "held a LAN address list until pairing names a desktop")
            } else {
                fileLanAddresses(desktopId, pushed)
            }
        }
        controller = PairingController(
            store = keys,
            machineId = PhoneIdentity.machineId(context),
            scheduler = CoroutineScheduler(scope),
            onInbound = client::onInbound,
        )

        // A handshake belongs to ONE TRANSPORT, not merely to one connection.
        // A swap from Bluetooth to LAN means the desktop has opened a brand new
        // SecureChannel over the new pipe, so the old session must be torn down
        // even though the link never went "down" from the app's point of view.
        //
        // SYNCHRONOUS, not a flow collector. The desktop sends its HELLO the
        // instant it accepts the new transport, and a coroutine that has not run
        // yet leaves the OLD channel's collector in place to eat it — and to
        // answer it with the old session's keys down the new socket. Observed on
        // real hardware as "Peer confirmation MAC failed". See HelmLink.
        HelmLink.onLinkChanged = { owner, linkState ->
            if (linkState == LinkState.Linked && owner != null) attach() else detach()
        }

        // One dial attempt per Bluetooth link, off the main thread. Only from
        // BLUETOOTH: dialling in response to the LAN link coming up would be
        // dialling because we just dialled.
        scope.launch {
            combine(HelmLink.state, HelmLink.owner) { linkState, owner -> linkState to owner }
                .distinctUntilChanged()
                .collect { (linkState, owner) ->
                    if (linkState == LinkState.Linked && owner == RANK_BLE) {
                        val desktopId = (controller?.state?.value as? PairingState.Linked)?.desktopId
                        if (desktopId != null) scope.launch(Dispatchers.IO) { lan?.tryConnect(desktopId) }
                    }
                }
        }

        // The desktops list is derived from the pairing state, so it follows it
        // rather than being poked from every place that could change it: a new
        // pairing, a dropped link and a revocation all land here as one update.
        scope.launch { requireController().state.collect { refreshDesktops() } }
    }

    /**
     * Drop the LAN link on purpose — the quit path only. The controller is NOT
     * stopped on service teardown or backgrounding: those must keep LAN up
     * (that is the point of backgrounding), and its non-daemon pump thread
     * holds the process open after finish() if nobody closes the socket.
     */
    fun stopLan() {
        lan?.stop()
    }

    fun confirm(matches: Boolean) = requireController().confirm(matches)

    fun cancel() = requireController().cancel()

    fun dismissFailure() = requireController().dismissFailure()

    fun forget(desktopId: String) {
        requireController().forget(desktopId)
        // A forgotten desktop leaves nothing behind, addresses included.
        lanAddresses?.forget(desktopId)
        // forget() only moves the pairing state when the REVOKED desktop is the
        // live one, so the row must be dropped here too.
        refreshDesktops()
    }

    /** Blank clears the nickname and returns the row to its derived default. */
    fun rename(desktopId: String, label: String) {
        store?.setLabel(desktopId, label)
        refreshDesktops()
    }

    private fun refreshDesktops() {
        val keys = store ?: return
        val linked = (controller?.state?.value as? PairingState.Linked)?.desktopId
        // The pairing state drives this, so it is also where a held address
        // list learns whose it is — a first pairing reaches Linked here.
        val held = pendingLanAddresses
        if (linked != null && held != null) {
            pendingLanAddresses = null
            fileLanAddresses(linked, held)
        }
        _desktops.value = pairedDesktops(keys, linked)
    }

    /** Store an address list against its desktop and try it immediately. */
    private fun fileLanAddresses(desktopId: String, pushed: List<String>) {
        lanAddresses?.save(desktopId, pushed)
        // The FIRST list a phone ever receives arrives after the Bluetooth link
        // came up, so waiting for the next link would leave LAN unused for a
        // whole session.
        scope.launch(Dispatchers.IO) { lan?.tryConnect(desktopId) }
    }

    /** False when there is no authenticated link to carry the message. */
    fun send(message: ByteArray): Boolean = requireController().send(message)

    private fun attach() {
        detach()
        // Bound to the transport that just took the link — the channel above
        // must read only its bytes, never another transport's tail.
        val rank = HelmLink.holderRank ?: return
        pipe = HelmLinkPipe(scope, rank).also { requireController().attach(it) }
    }

    private fun detach() {
        pipe?.close()
        pipe = null
        // Anything still waiting on the old link will never be answered over it.
        client.onLinkLost()
    }

    private fun requireController(): PairingController =
        controller ?: error("HelmPairing.init has not been called")

    /** Alongside the log, under the app's own files — never shared storage. */
    private const val NOTIFY_DIRECTORY = "notify"
}
