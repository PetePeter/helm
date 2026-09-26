package com.potatomotato.helm.voice

import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.Delivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the call hears from the target's thread: new replies, and sends that failed. */
class CallFeedTest {
    private fun agent(key: String, text: String) = ChatMessage(key = key, text = text, at = 0, fromPhone = false)
    private fun mine(key: String, delivery: Delivery) =
        ChatMessage(key = key, text = "said", at = 0, fromPhone = true, delivery = delivery)

    @Test
    fun `history already in the thread when the call starts is never read out`() {
        val feed = CallFeed(listOf(agent("m1", "old news")))

        assertTrue(feed.next(listOf(agent("m1", "old news"))).replies.isEmpty())
    }

    @Test
    fun `new agent rows are replies, in thread order`() {
        val feed = CallFeed(emptyList())

        val events = feed.next(listOf(agent("m1", "on it"), mine("m2", Delivery.Sent), agent("m3", "done")))

        assertEquals(listOf("on it", "done"), events.replies)
        assertEquals(0, events.failures)
    }

    @Test
    fun `an own row settling as failed counts once`() {
        val feed = CallFeed(emptyList())
        feed.next(listOf(mine("m1", Delivery.Sending)))

        assertEquals(1, feed.next(listOf(mine("m1", Delivery.Failed))).failures)
        assertEquals(0, feed.next(listOf(mine("m1", Delivery.Failed))).failures)
    }

    @Test
    fun `a reply is not repeated on the next observation`() {
        val feed = CallFeed(emptyList())
        feed.next(listOf(agent("m1", "on it")))

        assertTrue(feed.next(listOf(agent("m1", "on it"))).replies.isEmpty())
    }
}
