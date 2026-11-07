package com.potatomotato.helm.data

/** One context-size reading from a reply or a session-list observation. */
data class ContextSample(val at: Long, val tokens: Long, val level: ContextLevel? = null)

/** Token counts where the graph turns amber and red. */
data class ContextLimits(val amber: Long, val red: Long)

/** A session's readings, oldest first, plus the latest known model window and warning limits. */
data class ContextHistory(val samples: List<ContextSample>, val window: Long?, val limits: ContextLimits?)

data class ContextSparklinePoint(val x: Float, val y: Float)

enum class ContextLevel { Ok, Warn, Hot }

/** The context ring's geometry; mirrors `contextRing` in src/session/context-limits.ts. */
data class ContextRing(
    /** 0..1 of the circle, capped: a session past the circle is [overflow], not a bigger fill. */
    val fill: Float,
    val amberAt: Float,
    val redAt: Float,
    val level: ContextLevel,
    val overflow: Boolean,
)

/**
 * The token-fill graph's model, built from reply stats and timestamped
 * session-list observations inside the rolling row window.
 */
object ContextGraph {
    /** The list row's rolling span. Mirrors the desktop row. */
    const val ROW_SPAN_MS = 2L * 60 * 60 * 1000

    fun fromThread(
        thread: List<ChatMessage>,
        latest: SessionContext? = null,
        observations: List<ContextSample> = emptyList(),
        now: Long = System.currentTimeMillis(),
    ): ContextHistory? {
        val replies = thread.filter { !it.fromPhone && it.contextTokens != null }.sortedBy { it.at }
        val rowContext = latest?.takeIf { it.tokens > 0 }
        val cutoff = now - ROW_SPAN_MS
        val samples = replies
            .filter { it.at in cutoff..now }
            .map { ContextSample(it.at, it.contextTokens!!) } +
            observations.filter { it.at in cutoff..now }
        val windowedSamples = samples.sortedBy { it.at }
        if (windowedSamples.isEmpty()) return null
        val window = rowContext?.window?.takeIf { it > 0 }
            ?: replies.lastOrNull { it.contextWindow != null && it.contextWindow > 0 }?.contextWindow
        val sent = replies.lastOrNull { it.contextAmber != null && it.contextRed != null }
        return ContextHistory(
            samples = windowedSamples,
            window = window,
            limits = sent?.let { ContextLimits(it.contextAmber!!, it.contextRed!!) } ?: autoLimits(window),
        )
    }

    /** The desktop's default (src/session/context-limits.ts), for replies from a desktop that sends no limits. */
    fun autoLimits(window: Long?): ContextLimits? =
        window?.takeIf { it > 0 }?.let { ContextLimits(Math.round(it * 0.75), Math.round(it * 0.9)) }

    /** How full the latest reading is, 0..1, against the window (else the red limit); null when neither is known. */
    fun fill(history: ContextHistory): Float? {
        val ceiling = history.window?.takeIf { it > 0 } ?: history.limits?.red?.takeIf { it > 0 } ?: return null
        return (history.samples.last().tokens.toFloat() / ceiling).coerceIn(0f, 1f)
    }

    /** The ring for a session's latest reading; null until a reading and limits exist. */
    fun ring(history: ContextHistory): ContextRing? = history.samples.lastOrNull()?.let { ring(it.tokens, history.limits) }

    /**
     * What the graph's top edge stands for: the red limit (or the peak, if higher)
     * plus a tenth of room, capped at the window. Scaling to the whole window left
     * a normal session as a flat line along the bottom. Mirrors `sparklineCeiling`
     * in renderer/context-sparkline.ts.
     */
    fun ceiling(samples: List<ContextSample>, limits: ContextLimits?, window: Long?): Long {
        val peak = maxOf(1L, samples.maxOfOrNull { it.tokens } ?: 1L)
        val hasWindow = window != null && window > 0
        val reference = if (limits != null) maxOf(peak, limits.red) else peak
        val ceiling = if (limits != null || hasWindow) reference + reference / 10 else reference
        return if (hasWindow) minOf(ceiling, window!!) else ceiling
    }

    /** Point geometry for the sparkline; a lone reading is centered in the graph. */
    fun sparklinePoints(
        samples: List<ContextSample>,
        ceiling: Float,
        width: Float,
        height: Float,
    ): List<ContextSparklinePoint> {
        if (samples.isEmpty()) return emptyList()
        val scale = ceiling.coerceAtLeast(1f)
        fun y(sample: ContextSample) = height - (sample.tokens.toFloat() / scale).coerceIn(0f, 1f) * height
        if (samples.size == 1) return listOf(ContextSparklinePoint(width / 2f, y(samples.single())))

        val first = samples.first().at
        val span = (samples.last().at - first).coerceAtLeast(1L).toFloat()
        return samples.map { sample ->
            ContextSparklinePoint((sample.at - first) / span * width, y(sample))
        }
    }

    /** "152k / 200k · 76%" for the latest reading; just "152k" when the window is unknown. */
    fun summary(history: ContextHistory): String? {
        val tokens = history.samples.lastOrNull()?.tokens ?: return null
        val window = history.window?.takeIf { it > 0 } ?: return compact(tokens)
        return "${compact(tokens)} / ${compact(window)} · ${Math.round(tokens * 100.0 / window)}%"
    }

    private fun compact(n: Long): String = if (n >= 1_000) "${Math.round(n / 1_000.0)}k" else "$n"

    /** Where red sits on the ring, as a share of the circle (the auto rule's red/window). */
    const val RING_RED_AT = 0.9f

    /**
     * Red sits at a fixed point of the circle and everything else scales from the
     * limits, so a user limit and the auto window share one picture. Null without
     * limits: the caller draws a plain dot.
     */
    fun ring(tokens: Long, limits: ContextLimits?): ContextRing? {
        if (limits == null || limits.red <= 0) return null
        val full = limits.red / RING_RED_AT.toDouble()
        return ContextRing(
            fill = (tokens / full).coerceIn(0.0, 1.0).toFloat(),
            amberAt = (limits.amber / full).toFloat(),
            redAt = RING_RED_AT,
            level = level(tokens, limits),
            overflow = tokens > full,
        )
    }

    fun level(sample: ContextSample, limits: ContextLimits?): ContextLevel = sample.level ?: level(sample.tokens, limits)

    fun level(tokens: Long, limits: ContextLimits?): ContextLevel = when {
        limits == null -> ContextLevel.Ok
        tokens > limits.red -> ContextLevel.Hot
        tokens > limits.amber -> ContextLevel.Warn
        else -> ContextLevel.Ok
    }
}
