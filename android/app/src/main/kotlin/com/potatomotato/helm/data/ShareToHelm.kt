package com.potatomotato.helm.data

import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

/**
 * Share-to-Helm: one file from the Android share sheet (or the chat composer's
 * attach mode) lands in the Helm inbox (docs/mobile-app.md).
 *
 * One cap on either link: the desktop's own 10 MB ceiling. BLE used to be held
 * to 2 MB for speed; the user chose the bigger file over the shorter wait. The
 * refusal happens HERE, before a byte leaves — the desktop's cap is the
 * backstop, not the message.
 */
const val MAX_SHARE_BYTES: Long = MAX_STAGED_BYTES.toLong()

/** The tool a share opens with — what the permitted-tools answer must grant. */
const val METHOD_SHARE_ADD = "session_share_file_add"

/** The cap while a link is held; null with no link. */
fun shareCapBytes(holderRank: Int?): Long? = when (holderRank) {
    RANK_LAN, RANK_BLE -> MAX_SHARE_BYTES
    else -> null
}

/** Where one share has got to. The screen draws exactly this. */
sealed interface ShareState {
    /** Waiting for the user to pick a session. */
    data object Picking : ShareState

    /** Bytes are leaving: [sent] of [total]. */
    data class Sending(
        val sent: Long,
        val total: Long,
        val attemptId: Long = 0L,
        val waitStage: ShareWaitStage = ShareWaitStage.Uploading,
    ) : ShareState

    /** Landed. [message] is what the user reads. */
    data class Done(val message: String) : ShareState

    /** The user stopped an upload before Helm committed it. */
    data class Cancelled(val attemptId: Long) : ShareState

    /** Nothing landed — refused up front, or failed on the way. */
    data class Failed(val message: String, val attemptId: Long? = null) : ShareState
}

enum class ShareWaitStage { Uploading, AskToContinue, Waiting, Cancelling }

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
    fun start(attemptId: Long, total: Long): Boolean {
        if (_state.value is ShareState.Sending) return false
        _state.value = sending(attemptId, 0, total, ShareWaitStage.Uploading)
        return true
    }

    fun start(total: Long): Boolean = start(0L, total)

    fun askToContinue(attemptId: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        if (current.attemptId == attemptId && current.waitStage == ShareWaitStage.Uploading) {
            _state.value = sending(current.attemptId, current.sent, current.total, ShareWaitStage.AskToContinue)
        }
    }

    fun continueWaiting(attemptId: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        if (current.attemptId == attemptId && current.waitStage == ShareWaitStage.AskToContinue) {
            _state.value = sending(current.attemptId, current.sent, current.total, ShareWaitStage.Waiting)
        }
    }

    fun cancelling(attemptId: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        if (current.attemptId == attemptId) {
            _state.value = sending(current.attemptId, current.sent, current.total, ShareWaitStage.Cancelling)
        }
    }

    fun progress(attemptId: Long, sent: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        if (current.attemptId == attemptId) {
            _state.value = sending(
                current.attemptId,
                sent.coerceIn(current.sent, current.total),
                current.total,
                current.waitStage,
            )
        }
    }

    fun progress(sent: Long) = (_state.value as? ShareState.Sending)?.let { progress(it.attemptId, sent) }

    fun failed(attemptId: Long, message: String) {
        val current = _state.value
        if (current is ShareState.Sending && current.attemptId == attemptId) {
            _state.value = ShareState.Failed(message, attemptId)
        }
    }

    fun cancelled(attemptId: Long) {
        val current = _state.value as? ShareState.Sending ?: return
        if (current.attemptId == attemptId && current.waitStage == ShareWaitStage.Cancelling) {
            _state.value = ShareState.Cancelled(attemptId)
        }
    }

    fun done(attemptId: Long, sessionName: String) {
        val current = _state.value
        if ((current is ShareState.Sending && current.attemptId == attemptId)
            || (current is ShareState.Cancelled && current.attemptId == attemptId)
            || (current is ShareState.Failed && current.attemptId == attemptId)) {
            _state.value = ShareState.Done(shareDoneMessage(sessionName))
        }
    }

    fun done(sessionName: String) = (_state.value as? ShareState.Sending)?.let { done(it.attemptId, sessionName) }

    private fun sending(attemptId: Long, sent: Long, total: Long, waitStage: ShareWaitStage) =
        ShareState.Sending(sent, total, attemptId, waitStage)
}
