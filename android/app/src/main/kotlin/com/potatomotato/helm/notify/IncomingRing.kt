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
import com.potatomotato.helm.wire.MobileRecord

/**
 * The operator calling the user: a `kind: "ring"` chat record raised as an
 * incoming call rather than a shade row.
 *
 * WHY A NOTIFICATION, NOT A TELECOM CALL: accepting only has to start the
 * ordinary Call Helm flow, which already owns audio. A high-importance CALL
 * notification with a full-screen intent rings over the lock screen without a
 * ConnectionService, and stops ringing on its own after [RING_TIMEOUT_MS].
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

    fun ring(record: MobileRecord.Chat) {
        if (record.sessionId.isBlank()) return
        val accept = activityIntent(record.sessionId, REQUEST_ACCEPT)
            .putExtra(EXTRA_ACCEPT_SESSION, record.sessionId)
            .putExtra(EXTRA_ACCEPT_TICKET, tickets.issue(record.sessionId))
        val open = activityIntent(record.sessionId, REQUEST_OPEN)
            .putExtra(AndroidNotifications.EXTRA_SESSION_ID, record.sessionId)
        val decline = PendingIntent.getBroadcast(
            context,
            REQUEST_DECLINE,
            Intent(context, RingDeclineReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentTitle(context.getString(R.string.ring_title, record.sessionName.ifBlank { "Helm" }))
            .setContentText(record.text)
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
    override fun onReceive(context: Context, intent: Intent) = IncomingRing.dismiss(context)
}
