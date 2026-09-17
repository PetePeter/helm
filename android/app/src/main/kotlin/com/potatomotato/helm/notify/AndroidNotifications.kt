package com.potatomotato.helm.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
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
        val builder = builderFor(alert)
            .setContentText(alert.text)
        // Only a MESSAGE can be answered: the others report that something
        // happened, and a reply box on "a session went idle" would invite the
        // user to talk to an event.
        if (alert.kind == AlertKind.Message) builder.addAction(replyAction(alert))

        show(alert, builder.build())
    }

    override fun cancel(alert: Alert) {
        manager.cancel(alert.notificationId)
    }

    /**
     * The same row, rewritten to say the reply never left the phone — and still
     * carrying its reply box, because the obvious next thing the user wants is
     * to try again once the link is back.
     */
    override fun replyFailed(alert: Alert) {
        val builder = builderFor(alert)
            .setContentText(context.getString(R.string.reply_not_sent))
            .addAction(replyAction(alert))

        show(alert, builder.build())
    }

    private fun builderFor(alert: Alert): Notification.Builder =
        Notification.Builder(context, alert.kind.channelId)
            .setContentTitle(alert.sessionName)
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setColor(alert.kind.accent)
            .setColorized(false)
            .setContentIntent(openSession(alert))
            .setAutoCancel(true)
            .setShowWhen(true)

    private fun show(alert: Alert, notification: Notification) {
        try {
            manager.notify(alert.notificationId, notification)
        } catch (error: SecurityException) {
            // POST_NOTIFICATIONS was revoked mid-session. The link is fine.
            Log.w(TAG, "could not post an alert for ${alert.sessionId}: ${error.javaClass.simpleName}")
        }
    }

    /**
     * The reply box itself.
     *
     * It targets a BroadcastReceiver rather than the Activity so answering does
     * not drag the user into the app — the point of replying from the shade is
     * not to leave what you were doing. The intent is MUTABLE because RemoteInput
     * has to write the typed text into it; that is the one sanctioned reason, and
     * the receiver is not exported, so nothing outside the app can reach it.
     *
     * The request code is the notification id for the same reason the tap intent
     * uses it: equal request codes are the same PendingIntent to the system, and
     * a shared one would send every session's reply to whichever posted first.
     */
    private fun replyAction(alert: Alert): Notification.Action {
        val remoteInput = RemoteInput.Builder(ReplyReceiver.RESULT_KEY)
            .setLabel(context.getString(R.string.reply_hint))
            .build()

        val intent = Intent(context, ReplyReceiver::class.java)
            .setAction("${REPLY_ACTION}.${alert.sessionId}")
            .putExtra(EXTRA_SESSION_ID, alert.sessionId)
            .putExtra(EXTRA_SESSION_NAME, alert.sessionName)

        val pending = PendingIntent.getBroadcast(
            context,
            alert.notificationId,
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return Notification.Action.Builder(
            // The Icon overload, not the drawable-id one: that constructor is
            // deprecated, and a build warning nobody can fix is a warning
            // everybody learns to scroll past.
            Icon.createWithResource(context, android.R.drawable.ic_menu_send),
            context.getString(R.string.reply_action),
            pending,
        )
            .addRemoteInput(remoteInput)
            .build()
    }

    /**
     * Tapping lands in that session's thread — or, for an artifact row, in the
     * session's artifact list, which is where its artifacts live — from a cold
     * start as well as a warm one. [MainActivity] reads these extras in both
     * `onCreate` and `onNewIntent`.
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
        if (alert.kind == AlertKind.Artifact) intent.putExtra(EXTRA_ARTIFACTS, true)

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

        /** True when the tap wants the session's ARTIFACTS, not its thread. */
        const val EXTRA_ARTIFACTS = "com.potatomotato.helm.OPEN_ARTIFACTS"

        /** The session a reply belongs to. Read by [ReplyReceiver]. */
        const val EXTRA_SESSION_NAME = "com.potatomotato.helm.SESSION_NAME"

        private const val OPEN_ACTION = "com.potatomotato.helm.action.OPEN_SESSION"
        private const val REPLY_ACTION = "com.potatomotato.helm.action.REPLY"
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
        AlertKind.Message -> R.string.alert_channel_message
        AlertKind.Attention -> R.string.alert_channel_attention
        AlertKind.Completion -> R.string.alert_channel_completion
        AlertKind.Idle -> R.string.alert_channel_idle
        AlertKind.Artifact -> R.string.alert_channel_artifact
    }

private val AlertKind.channelDescriptionRes: Int
    get() = when (this) {
        AlertKind.Message -> R.string.alert_channel_message_description
        AlertKind.Attention -> R.string.alert_channel_attention_description
        AlertKind.Completion -> R.string.alert_channel_completion_description
        AlertKind.Idle -> R.string.alert_channel_idle_description
        AlertKind.Artifact -> R.string.alert_channel_artifact_description
    }
