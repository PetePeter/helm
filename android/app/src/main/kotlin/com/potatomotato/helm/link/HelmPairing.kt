package com.potatomotato.helm.link

import android.content.Context
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.DeviceKeyStore
import com.potatomotato.helm.data.PhoneIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

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
    private var started = false

    /**
     * What the app talks to once the handshake is done. It sends through [send],
     * so it inherits the rule that nothing leaves the phone before the link is
     * authenticated — there is no second way out.
     */
    val client = HelmClient(send = ::send)

    /** What the pairing screen renders. Idle until the first link comes up. */
    val state: StateFlow<PairingState>
        get() = requireController().state

    /** Called once from [com.potatomotato.helm.HelmApp]. */
    fun init(context: Context) {
        if (started) return
        started = true
        controller = PairingController(
            store = DeviceKeyStore(context),
            machineId = PhoneIdentity.machineId(context),
            scheduler = CoroutineScheduler(scope),
            onInbound = client::onInbound,
        )

        // A handshake belongs to ONE link. The phone cannot initiate, so every
        // new channel starts from the transport coming up, never from here.
        scope.launch {
            HelmLink.state.collect { linkState ->
                if (linkState == LinkState.Linked) attach() else detach()
            }
        }
    }

    fun confirm(matches: Boolean) = requireController().confirm(matches)

    fun forget(desktopId: String) = requireController().forget(desktopId)

    /** False when there is no authenticated link to carry the message. */
    fun send(message: ByteArray): Boolean = requireController().send(message)

    private fun attach() {
        detach()
        pipe = HelmLinkPipe(scope).also { requireController().attach(it) }
    }

    private fun detach() {
        pipe?.close()
        pipe = null
        // Anything still waiting on the old link will never be answered over it.
        client.onLinkLost()
    }

    private fun requireController(): PairingController =
        controller ?: error("HelmPairing.init has not been called")
}
