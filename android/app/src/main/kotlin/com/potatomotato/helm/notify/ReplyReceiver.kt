package com.potatomotato.helm.notify

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.HelmLog

/**
 * ReplyReceiver — the shade's reply box, wired to the link.
 *
 * ```mermaid
 * graph LR
 *     N[Notification<br/>RemoteInput] -->|broadcast| RR[ReplyReceiver]
 *     RR --> RD[ReplyDelivery<br/>the decisions]
 *     RD -->|sendChat| HC[HelmClient]
 *     HC -->|no link| TH[thread: Delivery.Failed]
 *     RD -->|Failed| NP[NotificationPort<br/>replyFailed]
 * ```
 *
 * WHY a receiver and not the Activity: replying from a lock screen should not
 * open the app. That is the whole appeal of the box.
 *
 * WHY it can reach the link at all — the question that decided whether this
 * feature was buildable. [HelmPairing] is process-scoped, exactly like
 * [com.potatomotato.helm.ble.HelmLink], so a receiver running in this process
 * talks to the same client the UI does. And if a notification exists to reply
 * to, a message arrived over BLE, which means the foreground service was up and
 * the process alive. A process killed since then takes the link with it —
 * `sendChat` then returns false, the thread records the failure, and the row
 * says so. That path is [ReplyDelivery]'s, and it is tested.
 *
 * This class is a SHELL: it unpacks the intent and hands over. Everything worth
 * asserting lives in [ReplyDelivery], where no device is needed to reach it.
 */
class ReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(AndroidNotifications.EXTRA_SESSION_ID).orEmpty()
        val sessionName = intent.getStringExtra(AndroidNotifications.EXTRA_SESSION_NAME).orEmpty()
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(RESULT_KEY)?.toString().orEmpty()

        val delivery = ReplyDelivery(HelmPairing.client::sendChat)
        // The reply text is a PAYLOAD: the outcome and the session are logged,
        // never what the user typed. HelmLog's one rule.
        val outcome = delivery.reply(sessionId, text)
        HelmLog.i(HelmLog.NOTIFY, "reply to $sessionId: $outcome")

        val router = HelmPairing.client.alerts
        when (outcome) {
            // Android has already collapsed the box into a spinner; taking the
            // row down is what tells the user it went.
            ReplyOutcome.Sent -> router.replySent(sessionId)
            ReplyOutcome.Failed -> router.replyFailed(sessionId, sessionName)
            // Nothing was sent and nothing was meant to be. Leaving the row as
            // it stands is the honest outcome of an empty tap.
            ReplyOutcome.Ignored -> Unit
        }
    }

    companion object {
        /** The key RemoteInput writes the typed text under. */
        const val RESULT_KEY = "com.potatomotato.helm.REPLY_TEXT"
    }
}
