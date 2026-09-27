package com.potatomotato.helm.voice

import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.Delivery

/** The desktop's role value for the one Helm operator session. */
const val OPERATOR_ROLE = "operator"

/** What one look at the target's thread found: replies to speak, sends that failed. */
data class CallEvents(val replies: List<String>, val failures: Int)

/**
 * The call's view of the target's chat thread, turned into events.
 *
 * The thread is the ONE source of what the target said — the same journal the
 * chat screen reads — so the call cannot disagree with the transcript. Rows
 * present when the call began are history, never read out.
 */
class CallFeed(initial: List<ChatMessage>) {
    private val seen = initial.mapTo(HashSet()) { it.key }
    private val failed = initial.filter { it.delivery == Delivery.Failed }.mapTo(HashSet()) { it.key }

    fun next(thread: List<ChatMessage>): CallEvents {
        val replies = thread.filter { !it.fromPhone && seen.add(it.key) }.map { it.text }
        thread.forEach { seen.add(it.key) }
        val failures = thread.count { it.fromPhone && it.delivery == Delivery.Failed && failed.add(it.key) }
        return CallEvents(replies, failures)
    }
}
