package com.potatomotato.helm.ui.chat

/**
 * Where each thread was left, for this process only. Deliberately never saved:
 * reopening the app starts every thread at its newest bubble. A thread left at
 * the bottom has no spot, so it reopens at the NEW bottom and keeps following.
 */
internal class ChatScrollMemory {
    data class Spot(val index: Int, val offset: Int)

    private val spots = mutableMapOf<String, Spot>()

    /** Null = open at the end. */
    fun recall(sessionId: String): Spot? = spots[sessionId]

    fun settle(sessionId: String, atEnd: Boolean, index: Int, offset: Int) {
        if (atEnd) spots.remove(sessionId) else spots[sessionId] = Spot(index, offset)
    }

    companion object {
        val Process = ChatScrollMemory()
    }
}
