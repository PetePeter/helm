package com.potatomotato.helm.notify

/**
 * What an answered ring says first, within a breath of Answer: silence after
 * picking up reads as a dead call. It asks rather than launches into the
 * message, so the user can say yes, no, or "call me back in ten minutes" —
 * the operator hears the answer and honours it.
 */
object RingGreeting {
    /** The topic is a headline, not the message: long reasons are cut at a word. */
    const val MAX_TOPIC_CHARS = 90

    fun line(reason: String): String {
        val topic = shorten(reason.trim().trimEnd('.', '!', '?'))
        return if (topic.isEmpty()) {
            "Hi, it's Helm. I have a message for you. Is now a good time?"
        } else {
            "Hi, it's Helm. I have a message about $topic. Is now a good time?"
        }
    }

    private fun shorten(topic: String): String {
        if (topic.length <= MAX_TOPIC_CHARS) return topic
        val cut = topic.take(MAX_TOPIC_CHARS).substringBeforeLast(' ').trimEnd()
        return "$cut…"
    }
}
