package com.potatomotato.helm.data

/** One context-size reading taken from a reply's stats. */
data class ContextSample(val at: Long, val tokens: Long)

/** Token counts where the graph turns amber and red. */
data class ContextLimits(val amber: Long, val red: Long)

/** A session's readings, oldest first, plus the latest known model window and warning limits. */
data class ContextHistory(val samples: List<ContextSample>, val window: Long?, val limits: ContextLimits?)

enum class ContextLevel { Ok, Warn, Hot }

/**
 * The token-fill graph's model, built from the stats every reply already
 * carries (tokens, window, amber/red limits); a session that has never
 * replied over chat simply has no graph.
 */
object ContextGraph {
    /** The list row's fixed span, so rows share one time scale. Mirrors the desktop row. */
    const val ROW_SPAN_MS = 2L * 60 * 60 * 1000

    fun fromThread(thread: List<ChatMessage>): ContextHistory? {
        val replies = thread.filter { !it.fromPhone && it.contextTokens != null }.sortedBy { it.at }
        if (replies.isEmpty()) return null
        val window = replies.lastOrNull { it.contextWindow != null && it.contextWindow > 0 }?.contextWindow
        val sent = replies.lastOrNull { it.contextAmber != null && it.contextRed != null }
        return ContextHistory(
            samples = replies.map { ContextSample(it.at, it.contextTokens!!) },
            window = window,
            limits = sent?.let { ContextLimits(it.contextAmber!!, it.contextRed!!) } ?: autoLimits(window),
        )
    }

    /** The desktop's default (src/session/context-limits.ts), for replies from a desktop that sends no limits. */
    fun autoLimits(window: Long?): ContextLimits? =
        window?.takeIf { it > 0 }?.let { ContextLimits(Math.round(it * 0.75), Math.round(it * 0.9)) }

    /** Clip to [from, to]; the prior level enters at the left edge and the latest runs out to [to]. */
    fun window(samples: List<ContextSample>, from: Long, to: Long): List<ContextSample> {
        val known = samples.filter { it.at <= to }
        if (known.isEmpty()) return emptyList()
        val before = known.lastOrNull { it.at < from }
        val clipped = listOfNotNull(before?.let { ContextSample(from, it.tokens) }) + known.filter { it.at >= from }
        val last = clipped.last()
        return if (last.at < to) clipped + ContextSample(to, last.tokens) else clipped
    }

    fun level(tokens: Long, limits: ContextLimits?): ContextLevel = when {
        limits == null -> ContextLevel.Ok
        tokens > limits.red -> ContextLevel.Hot
        tokens > limits.amber -> ContextLevel.Warn
        else -> ContextLevel.Ok
    }
}
