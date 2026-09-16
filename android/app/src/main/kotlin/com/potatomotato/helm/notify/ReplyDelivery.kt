package com.potatomotato.helm.notify

import com.potatomotato.helm.log.HelmLog

/** What became of a reply typed into a notification. */
enum class ReplyOutcome {

    /** Handed to the link. Whether the desktop liked it is the thread's business. */
    Sent,

    /** Nothing to send, or nowhere to send it. The user is told nothing. */
    Ignored,

    /** There was something to send and it could not go. The user IS told. */
    Failed,
}

/**
 * ReplyDelivery — what happens when the user types into a notification.
 *
 * WHY it exists as its own class: the real caller is a BroadcastReceiver, which
 * fires when the app may be backgrounded or the Activity long gone. That is
 * unreachable from a JVM test and awkward to reason about on a device, yet every
 * decision worth making — a blank reply, a missing session, a link that is down,
 * a sender that throws — is ordinary logic. Same seam as [NotificationPort].
 *
 * WHY no queue for a reply that cannot go out: there already is one, in the only
 * place the user will look. `HelmClient.sendChat` puts the message in the thread
 * before it calls, and settles it as `Delivery.Failed` when the link refuses it,
 * so an unsendable reply is visible as a failed message rather than lost. A
 * second queue here would be a copy of that, with the added job of deciding when
 * a stale reply stops being worth sending — a question nobody has asked.
 *
 * The one rule of [HelmLog] applies with unusual force here: the reply text is a
 * PAYLOAD and is never logged. Outcomes and session ids only.
 */
class ReplyDelivery(private val send: (sessionId: String, text: String) -> Boolean) {

    fun reply(sessionId: String, text: String): ReplyOutcome {
        val body = text.trim()
        // A lock screen invites accidental gestures, and an empty reply that woke
        // an agent would be worse than the tap being ignored.
        if (sessionId.isBlank() || body.isEmpty()) return ReplyOutcome.Ignored

        val delivered = try {
            send(sessionId, body)
        } catch (error: Throwable) {
            // An uncaught throw inside a receiver is a crash dialog over whatever
            // the user was doing. The link is allowed to fail; the phone is not.
            HelmLog.e(HelmLog.NOTIFY, "reply to $sessionId threw", error)
            false
        }

        return if (delivered) ReplyOutcome.Sent else ReplyOutcome.Failed
    }
}
