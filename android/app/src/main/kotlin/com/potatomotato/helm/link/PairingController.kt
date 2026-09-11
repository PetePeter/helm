package com.potatomotato.helm.link

import com.potatomotato.helm.crypto.BytePipe
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.crypto.RefusalCode
import com.potatomotato.helm.crypto.SecureChannel
import com.potatomotato.helm.crypto.SecureChannelListener
import com.potatomotato.helm.data.PskStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the pairing screen is showing. */
sealed interface PairingState {
    /** No desktop on the line. */
    data object Idle : PairingState

    /** A handshake is in flight; nothing to show yet. */
    data object Handshaking : PairingState

    /** Screen 5: the user compares [sas] with the six digits on the desktop. */
    data class Comparing(val desktopId: String, val sas: String) : PairingState

    /** Authenticated and usable. */
    data class Linked(val desktopId: String) : PairingState

    /** Something the user can act on — a version mismatch, a failed handshake. */
    data class Failed(val message: String) : PairingState
}

/**
 * PairingController — the phone's link lifecycle above the crypto.
 *
 * It owns exactly three decisions: which PSK to offer, what the screen shows,
 * and whether a completed handshake is written to disk. Everything else belongs
 * either below it (in [SecureChannel]) or above it (in the UI), and keeping it
 * free of Android types is what lets all three be tested on the JVM.
 *
 * A rejected pairing persists NOTHING. That is the whole reason the store is
 * touched here, after the verdict, and never inside the channel.
 */
class PairingController(
    private val store: PskStore,
    private val machineId: String,
    private val scheduler: ChannelScheduler,
    private val onInbound: (ByteArray) -> Unit = {},
    private val openChannel: (
        pipe: BytePipe,
        listener: SecureChannelListener,
        pskFor: (String) -> ByteArray?,
    ) -> SecureChannel = { pipe, listener, pskFor ->
        SecureChannel(
            pipe = pipe,
            machineId = machineId,
            listener = listener,
            scheduler = scheduler,
            pskFor = pskFor,
        )
    },
) : SecureChannelListener {
    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state.asStateFlow()

    private var channel: SecureChannel? = null

    /** Run a handshake over a freshly linked pipe. Replaces any previous one. */
    fun attach(pipe: BytePipe) {
        channel?.close("replaced by a new link")
        _state.value = PairingState.Handshaking
        channel = openChannel(pipe, this, store::load).also { it.start() }
    }

    /**
     * The user's verdict on the six digits. `true` is the ONLY path that writes
     * a PSK to disk; `false` closes the link and leaves the store untouched.
     */
    fun confirm(matches: Boolean) {
        val live = channel ?: return
        if (!matches) {
            live.confirmSas(false)
            return
        }
        val psk = live.pairingPsk
        val desktopId = live.peerMachine
        live.confirmSas(true)
        if (live.isClosed) return
        store.save(desktopId, psk)
        _state.value = PairingState.Linked(desktopId)
    }

    /** Send one application message. False when there is no usable link. */
    fun send(message: ByteArray): Boolean {
        val live = channel ?: return false
        if (_state.value !is PairingState.Linked) return false
        return try {
            live.send(message)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Drop a pairing. The next connection from that desktop asks for the SAS again. */
    fun forget(desktopId: String) {
        store.forget(desktopId)
        if ((_state.value as? PairingState.Linked)?.desktopId == desktopId) {
            channel?.close("pairing revoked")
        }
    }

    override fun onEstablished(channel: SecureChannel) {
        _state.value = if (channel.sasConfirmationRequired) {
            PairingState.Comparing(channel.peerMachine, channel.sas)
        } else {
            PairingState.Linked(channel.peerMachine)
        }
    }

    override fun onMessage(plaintext: ByteArray) = onInbound(plaintext)

    override fun onRefused(code: RefusalCode, message: String) {
        // The message already names both sides and says which one to update;
        // rewriting it here would fork the wording from the desktop's.
        _state.value = PairingState.Failed(message)
    }

    override fun onClosed(reason: String) {
        channel = null
        // A refusal has already put an actionable message on screen; anything
        // else is just a link that went away.
        if (_state.value !is PairingState.Failed) _state.value = PairingState.Idle
    }
}
