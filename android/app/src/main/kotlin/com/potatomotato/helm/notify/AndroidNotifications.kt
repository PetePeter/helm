package com.potatomotato.helm.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.compose.ui.graphics.toArgb
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors

/**
 * [NotificationPort] against the real system shade. TRANSLATION ONLY — every
 * decision about whether, when and what to post is [AlertRouter]'s.
 *
 * Three channels, created once, so the user can silence "a session went idle"
 * without silencing "a session needs you". That split is the whole reason there
 * is more than one channel; Android gives the user no way to filter within one.
 *
 * Nothing here throws into the link: a notification that cannot be posted (the
 * user revoked POST_NOTIFICATIONS while the app was running) is logged and
 * dropped. Per invariant 7's spirit, the transport outlives its payloads.
 */
class AndroidNotifications(private val context: Context) : NotificationPort {

    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        for (kind in AlertKind.entries) {
            val channel = NotificationChannel(
                kind.channelId,
                context.getString(kind.channelNameRes),
                // DEFAULT, not HIGH: this buzzes a phone in a pocket, and an
                // event that is worth knowing is not the same as one worth
                // interrupting a conversation for. The user can raise it.
                NotificationManager.IMPORTANCE_DEFAULT,
            )
            channel.description = context.getString(kind.channelDescriptionRes)
            manager.createNotificationChannel(channel)
        }
    }

    override fun post(alert: Alert) {
        val notification = Notification.Builder(context, alert.kind.channelId)
            .setContentTitle(alert.sessionName)
            .setContentText(alert.text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setColor(alert.kind.accent)
            .setColorized(false)
            .setContentIntent(openSession(alert))
            .setAutoCancel(true)
            .setShowWhen(true)
            .build()

        try {
            manager.notify(alert.notificationId, notification)
        } catch (error: SecurityException) {
            // POST_NOTIFICATIONS was revoked mid-session. The link is fine.
            Log.w(TAG, "could not post an alert for ${alert.sessionId}: ${error.javaClass.simpleName}")
        }
    }

    override fun cancel(sessionId: String) {
        manager.cancel(Alert.notificationId(sessionId))
    }

    /**
     * Tapping lands in that session's thread, from a cold start as well as a warm
     * one — [MainActivity] reads this extra in both `onCreate` and `onNewIntent`.
     *
     * The request code is the notification id, not 0: PendingIntents with equal
     * request codes are the SAME intent to the system, so a shared code would
     * hand every session's notification the extras of whichever posted first.
     */
    private fun openSession(alert: Alert): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction("${OPEN_ACTION}.${alert.sessionId}")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_SESSION_ID, alert.sessionId)

        return PendingIntent.getActivity(
            context,
            alert.notificationId,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    companion object {
        /** The session a notification tap is asking for. Read by [MainActivity]. */
        const val EXTRA_SESSION_ID = "com.potatomotato.helm.OPEN_SESSION"

        private const val OPEN_ACTION = "com.potatomotato.helm.action.OPEN_SESSION"
        private const val TAG = "HelmNotifications"
    }
}

/**
 * The accent a notification is tinted with.
 *
 * Amber for attention — the same meaning as the flash dot, per invariant 8 — and
 * the app accent for everything else. Read from [com.potatomotato.helm.ui.theme.HelmColors]
 * rather than declared here, because nothing outside `ui/theme` may name a colour.
 */
private val AlertKind.accent: Int
    get() = if (isFlash) FLASH_ARGB else ACCENT_ARGB

private val FLASH_ARGB = HelmColors.State.Flash.toArgb()
private val ACCENT_ARGB = HelmColors.Accent.toArgb()

private val AlertKind.channelNameRes: Int
    get() = when (this) {
        AlertKind.Attention -> R.string.alert_channel_attention
        AlertKind.Completion -> R.string.alert_channel_completion
        AlertKind.Idle -> R.string.alert_channel_idle
    }

private val AlertKind.channelDescriptionRes: Int
    get() = when (this) {
        AlertKind.Attention -> R.string.alert_channel_attention_description
        AlertKind.Completion -> R.string.alert_channel_completion_description
        AlertKind.Idle -> R.string.alert_channel_idle_description
    }
