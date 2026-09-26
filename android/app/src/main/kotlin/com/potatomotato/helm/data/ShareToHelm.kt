package com.potatomotato.helm.data

import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

/**
 * Share-to-Helm: one file from the Android share sheet lands in the Helm inbox
 * and a DRAFT on the picked session names its path (docs/mobile-app.md).
 *
 * The cap depends on the link carrying it. LAN takes the desktop's own 10 MB
 * ceiling; BLE is held to 2 MB because the radio moves tens of KB a second, and
 * a transfer measured in many minutes is one the user abandons half-way. The
 * refusal happens HERE, before a byte leaves — the desktop's cap is the
 * backstop, not the message.
 */
const val MAX_SHARE_BYTES_LAN: Long = MAX_STAGED_BYTES.toLong()
const val MAX_SHARE_BYTES_BLE: Long = 2L * 1024 * 1024

/** The cap for the transport that holds the link now; null with no link. */
fun shareCapBytes(holderRank: Int?): Long? = when (holderRank) {
    RANK_LAN -> MAX_SHARE_BYTES_LAN
    RANK_BLE -> MAX_SHARE_BYTES_BLE
    else -> null
}

/** Where one share has got to. The screen draws exactly this. */
sealed interface ShareState {
    /** Waiting for the user to pick a session. */
    data object Picking : ShareState

    /** Bytes are leaving: [sent] of [total]. */
    data class Sending(val sent: Long, val total: Long) : ShareState

    /** Landed. [message] is what the user reads. */
    data class Done(val message: String) : ShareState

    /** Nothing landed — refused up front, or failed on the way. */
    data class Failed(val message: String) : ShareState
}

/**
 * Why a share must not start, or null when it may. Checked before the slot is
 * opened so every refusal is legible and costs no radio time.
 */
fun shareRefusal(sizeBytes: Long, holderRank: Int?, support: UploadSupport): String? {
    val cap = shareCapBytes(holderRank)
    return when {
        support == UploadSupport.Offline || cap == null -> "Not connected to Helm"
        support == UploadSupport.DesktopTooOld -> "This Helm is too old to receive files — update it"
        support == UploadSupport.NotPermitted -> "Helm has not allowed this phone to share files"
        sizeBytes <= 0L -> "The file is empty"
        sizeBytes > cap -> {
            val link = if (holderRank == RANK_LAN) "Wi-Fi" else "Bluetooth"
            "Too large for $link: ${megabytes(sizeBytes)} (limit ${megabytes(cap)})"
        }
        else -> null
    }
}

/** The success line — the one thing the user needs to know. */
fun shareDoneMessage(sessionName: String): String = "Added to $sessionName draft"

/** A byte count the way the share screen and its refusals print it. */
fun megabytes(bytes: Long): String =
    String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))

/**
 * The single share in flight. Owned by the client (like [ArtifactUploads]) so
 * the async answers from the link have somewhere to land that outlives a
 * recomposition.
 */
class ShareFlow {
    private val _state = MutableStateFlow<ShareState>(ShareState.Picking)
    val state: StateFlow<ShareState> = _state.asStateFlow()

    /** A new share starts from the picker, whatever the last one did. */
    fun reset() {
        _state.value = ShareState.Picking
    }

    /** Refused before it started, or failed on the way. Terminal. */
    fun failed(message: String) {
        if (_state.value !is ShareState.Done) _state.value = ShareState.Failed(message)
    }

    /** Only one share at a time: a second start while one is sending is refused. */
    fun start(total: Long): Boolean {
        if (_state.value is ShareState.Sending) return false
        _state.value = ShareState.Sending(0, total)
        return true
    }

    fun progress(sent: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        _state.value = current.copy(sent = sent.coerceIn(current.sent, current.total))
    }

    fun done(sessionName: String) {
        _state.value = ShareState.Done(shareDoneMessage(sessionName))
    }
}
