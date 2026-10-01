package com.potatomotato.helm.telecom

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.TelecomManager
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.notify.IncomingRing
import com.potatomotato.helm.voice.VoiceCallService

/**
 * One Helm call as a self-managed call: a ring, or ([outgoing]) a call the user
 * started. Self-managed calls draw their own incoming UI, so
 * [onShowIncomingCallUi] raises the ring notification; what Telecom adds is
 * that the car and headset can answer, hang up and mute it too.
 */
class HelmConnection(
    private val context: Context,
    private val sessionId: String,
    private val sessionName: String,
    private val reason: String,
    outgoing: Boolean,
) : Connection() {

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        setCallerDisplayName(sessionName.ifBlank { "Helm" }, TelecomManager.PRESENTATION_ALLOWED)
        if (outgoing) {
            setDialing()
        } else {
            setRinging()
            // The notification stops after 30 s on its own; the system call must
            // too, or the car would ring forever. Unanswered = missed, so Helm's
            // one retry (desktop RingRetry) still applies.
            Handler(Looper.getMainLooper()).postDelayed({
                if (state == STATE_RINGING) finish(DisconnectCause(DisconnectCause.MISSED))
            }, RING_TIMEOUT_MS)
        }
    }

    private companion object {
        /** Matches the ring notification's own timeout. */
        const val RING_TIMEOUT_MS = 30_000L
    }

    override fun onShowIncomingCallUi() {
        IncomingRing(context).show(sessionId, sessionName, reason)
    }

    /**
     * Answered from the car, a headset or the system: the same accept path as
     * the notification's Answer, through MainActivity, which may start the
     * microphone service and checks the ring's one-shot ticket.
     */
    override fun onAnswer() {
        val accept = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(IncomingRing.EXTRA_ACCEPT_SESSION, sessionId)
            .putExtra(IncomingRing.EXTRA_ACCEPT_TICKET, IncomingRing.tickets.issue(sessionId))
            .putExtra(IncomingRing.EXTRA_ACCEPT_REASON, reason)
        context.startActivity(accept)
        setActive()
    }

    override fun onReject() {
        finish(DisconnectCause(DisconnectCause.REJECTED))
    }

    /** Hung up from the car or the system: hang up our call too. */
    override fun onDisconnect() {
        VoiceCallService.hangUp(context)
        finish(DisconnectCause(DisconnectCause.LOCAL))
    }

    override fun onAbort() = onDisconnect()

    /**
     * Muted or unmuted from the car or the system call UI (also fires on a
     * route change). Telecom has already flipped the phone's microphone mute;
     * the live call re-reads it.
     */
    @Deprecated("Deprecated in API 34, but the only mute callback down to minSdk 26")
    override fun onCallAudioStateChanged(state: CallAudioState?) {
        HelmTelecom.onAudioState?.invoke()
    }

    /** Our call ended first: take the system call down without looping back into hangUp. */
    fun endFromApp() {
        finish(DisconnectCause(DisconnectCause.LOCAL))
    }

    private fun finish(cause: DisconnectCause) {
        if (state == STATE_DISCONNECTED) return
        IncomingRing.dismiss(context)
        setDisconnected(cause)
        destroy()
        if (HelmTelecom.current === this) HelmTelecom.current = null
    }
}
