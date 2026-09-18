package com.potatomotato.helm.link

import com.potatomotato.helm.crypto.BytePipe
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.crypto.RefusalCode
import com.potatomotato.helm.crypto.SecureChannel
import com.potatomotato.helm.crypto.SecureChannelListener
import com.potatomotato.helm.data.PskStore
import com.potatomotato.helm.log.HelmLog
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
    /**
     * The link just became usable (handshake done AND SAS confirmed). Fired on
     * BOTH paths to [PairingState.Linked] — a first pairing and every reconnect
     * — because the client's link-up work must run whichever way the link
     * arrived. Empty by default so existing wiring and tests compile untouched.
     */
    private val onLinked: () -> Unit = {},
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

    /**
     * The wire protocol the live link negotiated — 0 with no link. The upload
     * surface greys from THIS (a protocol-3 desktop links fine and simply has no
     * upload half), so it must be readable without asking the channel.
     */
    val protocolVersion: Int
        get() = channel?.negotiatedVersion ?: 0

    /** Run a handshake over a freshly linked pipe. Replaces any previous one. */
    fun attach(pipe: BytePipe) {
        HelmLog.i(HelmLog.CHANNEL, "handshake beginning on a fresh link")
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
        if (live.isClosed) {
            HelmLog.w(HelmLog.CHANNEL, "the channel closed during SAS confirmation; nothing was persisted")
            return
        }
        HelmLog.i(HelmLog.CHANNEL, "SAS confirmed for $desktopId; the pairing is now stored")
        store.save(desktopId, psk)
        _state.value = PairingState.Linked(desktopId)
        onLinked()
    }

    /** Abort the in-flight handshake without changing the stored pairings. */
    fun cancel() {
        channel?.close("pairing cancelled by the user")
    }

    /**
     * Clear a failure the user has read, so the screen is not a dead end.
     *
     * Deliberately narrow: only [PairingState.Failed] is cleared, because a
     * dismiss that could also wipe a live SAS prompt or a working link would be
     * a way to lose state the user never asked to lose.
     */
    fun dismissFailure() {
        if (_state.value is PairingState.Failed) _state.value = PairingState.Idle
    }

    /** Send one application message. False when there is no usable link. */
    fun send(message: ByteArray): Boolean {
        val live = channel ?: return false
        if (_state.value !is PairingState.Linked) return false
        return try {
            live.send(message)
            true
        } catch (e: Exception) {
            HelmLog.w(HelmLog.CHANNEL, "the channel refused a send: ${e.javaClass.simpleName}")
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
        // The SAS DIGITS are never logged, only whether they are being asked for.
        HelmLog.i(
            HelmLog.CHANNEL,
            "channel established with ${channel.peerMachine}; " +
                "SAS confirmation required: ${channel.sasConfirmationRequired}",
        )
        if (channel.sasConfirmationRequired) {
            _state.value = PairingState.Comparing(channel.peerMachine, channel.sas)
        } else {
            _state.value = PairingState.Linked(channel.peerMachine)
            onLinked()
        }
    }

    override fun onMessage(plaintext: ByteArray) {
        HelmLog.v(HelmLog.CHANNEL) { "decrypted an application message of ${plaintext.size} bytes" }
        onInbound(plaintext)
    }

    override fun onRefused(code: RefusalCode, message: String) {
        HelmLog.w(HelmLog.CHANNEL, "the handshake was refused: $code")
        // The message already names both sides and says which one to update;
        // rewriting it here would fork the wording from the desktop's.
        _state.value = PairingState.Failed(message)
    }

    override fun onClosed(reason: String) {
        HelmLog.i(HelmLog.CHANNEL, "the channel closed: $reason")
        channel = null
        // A refusal has already put an actionable message on screen; anything
        // else is just a link that went away.
        if (_state.value !is PairingState.Failed) _state.value = PairingState.Idle
    }
}
