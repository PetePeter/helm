package com.potatomotato.helm.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.telecom.HelmTelecom
import com.potatomotato.helm.wire.MobileRecord

/**
 * The operator calling the user: a `kind: "ring"` chat record raised as an
 * incoming call rather than a shade row.
 *
 * The ring is offered to Telecom first ([HelmTelecom]) so the car and headset
 * can answer it; this CALL notification is its incoming UI either way, and the
 * whole ring when Telecom refuses. It stops on its own after [RING_TIMEOUT_MS].
 *
 * Accept opens [MainActivity] with [EXTRA_ACCEPT_SESSION]; starting the
 * microphone service from a visible activity is always permitted, from a
 * background broadcast it is not.
 */
class IncomingRing(private val context: Context) {

    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.ring_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        )
        channel.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build(),
        )
        channel.enableVibration(true)
        manager.createNotificationChannel(channel)
    }

    /**
     * A ring goes to Android's call system first (a real incoming call the car
     * and headset can answer); only when Telecom refuses does this notification
     * ring on its own.
     */
    fun ring(record: MobileRecord.Chat) {
        if (record.sessionId.isBlank()) return
        if (HelmTelecom.offer(context, record.sessionId, record.sessionName, record.text)) return
        show(record.sessionId, record.sessionName, record.text)
    }

    /** The incoming-call UI: Telecom asks for it (self-managed calls draw their own), or the fallback uses it. */
    fun show(sessionId: String, sessionName: String, reason: String) {
        val accept = activityIntent(sessionId, REQUEST_ACCEPT)
            .putExtra(EXTRA_ACCEPT_SESSION, sessionId)
            .putExtra(EXTRA_ACCEPT_TICKET, tickets.issue(sessionId))
            .putExtra(EXTRA_ACCEPT_REASON, reason)
        val open = activityIntent(sessionId, REQUEST_OPEN)
            .putExtra(AndroidNotifications.EXTRA_SESSION_ID, sessionId)
        val decline = PendingIntent.getBroadcast(
            context,
            REQUEST_DECLINE,
            Intent(context, RingDeclineReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentTitle(context.getString(R.string.ring_title, sessionName.ifBlank { "Helm" }))
            .setContentText(reason)
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .setContentIntent(pending(open, REQUEST_OPEN))
            .setFullScreenIntent(pending(open, REQUEST_FULL_SCREEN), true)
            .addAction(Notification.Action.Builder(null, context.getString(R.string.ring_decline), decline).build())
            .addAction(
                Notification.Action.Builder(null, context.getString(R.string.ring_accept), pending(accept, REQUEST_ACCEPT))
                    .build(),
            )
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (error: SecurityException) {
            Log.w(TAG, "could not ring: ${error.javaClass.simpleName}")
        }
    }

    private fun activityIntent(sessionId: String, request: Int): Intent =
        Intent(context, MainActivity::class.java)
            .setAction("$RING_ACTION.$request.$sessionId")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    private fun pending(intent: Intent, request: Int): PendingIntent =
        PendingIntent.getActivity(
            context,
            request,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    companion object {
        /** The session whose call the user accepted. Read by [MainActivity]. */
        const val EXTRA_ACCEPT_SESSION = "com.potatomotato.helm.RING_ACCEPT"

        /** The ring's one-shot ticket; an accept without the live one is refused. */
        const val EXTRA_ACCEPT_TICKET = "com.potatomotato.helm.RING_TICKET"

        /** The ring's reason, so the answered call can open by naming the topic. */
        const val EXTRA_ACCEPT_REASON = "com.potatomotato.helm.RING_REASON"

        /** Process-wide, so the ring that minted a ticket and the activity that redeems it agree. */
        val tickets = RingTicket()

        /** Stop ringing — Accept, Decline, or the call starting some other way. */
        fun dismiss(context: Context) =
            context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)

        private const val CHANNEL_ID = "helm_ring"
        private const val NOTIFICATION_ID = 3
        private const val RING_TIMEOUT_MS = 30_000L
        private const val RING_ACTION = "com.potatomotato.helm.action.RING"
        private const val REQUEST_OPEN = 7101
        private const val REQUEST_FULL_SCREEN = 7102
        private const val REQUEST_ACCEPT = 7103
        private const val REQUEST_DECLINE = 7104
        private const val TAG = "HelmRing"
    }
}

/** Decline: stop ringing without dragging the user into the app. */
class RingDeclineReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        IncomingRing.dismiss(context)
        // A real incoming call must be told too, or the car keeps ringing.
        HelmTelecom.reject()
    }
}
