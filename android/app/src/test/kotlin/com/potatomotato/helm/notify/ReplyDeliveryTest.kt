package com.potatomotato.helm.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reply box is only worth having if a reply that cannot be sent SAYS SO.
 *
 * These are the four things that can happen when the user types into a
 * notification and presses send, and the reason this logic lives behind a seam
 * at all: the real path runs in a BroadcastReceiver, which fires when the app
 * may be backgrounded and cannot be driven from a JVM test.
 */
class ReplyDeliveryTest {

    private val sent = mutableListOf<Pair<String, String>>()

    private fun delivery(outcome: Boolean = true) = ReplyDelivery { sessionId, text ->
        sent += sessionId to text
        outcome
    }

    @Test
    fun `a reply is sent to its own session`() {
        val result = delivery().reply("s1", "on it")

        assertEquals(listOf("s1" to "on it"), sent)
        assertEquals(ReplyOutcome.Sent, result)
    }

    /**
     * Android delivers whatever was in the box, and an accidental send is a real
     * gesture on a lock screen. An empty reply must not wake a session.
     */
    @Test
    fun `a blank reply sends nothing`() {
        assertEquals(ReplyOutcome.Ignored, delivery().reply("s1", "   "))
        assertEquals(ReplyOutcome.Ignored, delivery().reply("s1", ""))

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a reply with no session sends nothing`() {
        // The extra is missing or the intent was rebuilt: there is nowhere to
        // send it, and guessing a session would put words in the wrong thread.
        assertEquals(ReplyOutcome.Ignored, delivery().reply("", "on it"))

        assertTrue(sent.isEmpty())
    }

    /**
     * THE case the whole feature turns on: the notification is on the lock screen
     * and the link is down. `sendChat` already returns false and marks the row
     * failed in the thread, so the reply is not lost — but the user is looking at
     * a notification, not the thread, and must be told there.
     */
    @Test
    fun `a reply that cannot be sent reports failure rather than claiming success`() {
        assertEquals(ReplyOutcome.Failed, delivery(outcome = false).reply("s1", "on it"))
    }

    /**
     * A throw here would be an uncaught exception inside a BroadcastReceiver,
     * which is a crash dialog on the user's lock screen. Same rule as HelmLog's:
     * the surface never takes the app down.
     */
    @Test
    fun `a send that throws is contained and reported as a failure`() {
        val exploding = ReplyDelivery { _, _ -> throw IllegalStateException("the radio is gone") }

        assertEquals(ReplyOutcome.Failed, exploding.reply("s1", "on it"))
    }

    /**
     * Leading and trailing whitespace is an artefact of typing on a phone, not
     * something the user meant to say to an agent.
     */
    @Test
    fun `a reply is trimmed before it is sent`() {
        delivery().reply("s1", "  on it  ")

        assertEquals(listOf("s1" to "on it"), sent)
    }
}
