package com.potatomotato.helm.data

/** One context-size reading taken from a reply's stats. */
data class ContextSample(val at: Long, val tokens: Long)

/** A session's readings, oldest first, plus the latest known model window. */
data class ContextHistory(val samples: List<ContextSample>, val window: Long?)

enum class ContextLevel { Ok, Warn, Hot }

/**
 * The token-fill graph's model. v1 builds history from the stats every reply
 * already carries, so no wire change is needed; a session that has never
 * replied over chat simply has no graph.
 */
object ContextGraph {
    /** The list row's fixed span, so rows share one time scale. Mirrors the desktop row. */
    const val ROW_SPAN_MS = 2L * 60 * 60 * 1000

    fun fromThread(thread: List<ChatMessage>): ContextHistory? {
        val replies = thread.filter { !it.fromPhone && it.contextTokens != null }.sortedBy { it.at }
        if (replies.isEmpty()) return null
        return ContextHistory(
            samples = replies.map { ContextSample(it.at, it.contextTokens!!) },
            window = replies.lastOrNull { it.contextWindow != null && it.contextWindow > 0 }?.contextWindow,
        )
    }

    /** Clip to [from, to]; the prior level enters at the left edge and the latest runs out to [to]. */
    fun window(samples: List<ContextSample>, from: Long, to: Long): List<ContextSample> {
        val known = samples.filter { it.at <= to }
        if (known.isEmpty()) return emptyList()
        val before = known.lastOrNull { it.at < from }
        val clipped = listOfNotNull(before?.let { ContextSample(from, it.tokens) }) + known.filter { it.at >= from }
        val last = clipped.last()
        return if (last.at < to) clipped + ContextSample(to, last.tokens) else clipped
    }

    fun level(tokens: Long, window: Long?): ContextLevel {
        if (window == null || window <= 0) return ContextLevel.Ok
        val fill = tokens.toDouble() / window
        return when {
            fill > 0.85 -> ContextLevel.Hot
            fill > 0.7 -> ContextLevel.Warn
            else -> ContextLevel.Ok
        }
    }
}
