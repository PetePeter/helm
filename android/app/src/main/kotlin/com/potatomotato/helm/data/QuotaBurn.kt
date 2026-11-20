package com.potatomotato.helm.data

/**
 * How fast a subscription quota is being used, from the coarse history the
 * desktop sends with each session's quota. Mirrors src/session/quota-burn.ts:
 * the slope across the last hour of readings, ignoring readings from before a
 * window reset (a drop in used %).
 */
data class QuotaHistoryPoint(val at: Long, val fiveHour: Float, val weekly: Float)

data class QuotaBurn(
    /** Percent of the window used per hour; 0 when not rising. */
    val perHour: Float,
    /** Time until 100% at that rate; null when not rising. */
    val outInMs: Long?,
    /** It runs out before the window resets. */
    val beforeReset: Boolean,
)

enum class QuotaWindowKey { FiveHour, Weekly }

object QuotaBurns {
    const val HISTORY_SPAN_MS = 5 * 60 * 60_000L
    private const val RATE_LOOKBACK_MS = 60 * 60_000L
    private const val MIN_RATE_SPAN_MS = 10 * 60_000L
    private const val HOUR_MS = 60 * 60_000.0

    fun burn(usage: SessionQuotaUsage, key: QuotaWindowKey, now: Long): QuotaBurn? {
        val window = usage.window(key)
        val points = usage.history.map { it.at to it.used(key) } + (usage.measuredAtEpochMs to window.usedPercent)

        // Only the run since the last reset (a drop in used %) is this window.
        var start = points.lastIndex
        while (start > 0 && points[start - 1].second <= points[start].second) start--
        val run = points.subList(start, points.size)

        val from = run.firstOrNull { now - it.first <= RATE_LOOKBACK_MS } ?: run.last()
        val spanMs = usage.measuredAtEpochMs - from.first
        if (spanMs < MIN_RATE_SPAN_MS) return null

        val perHour = ((window.usedPercent - from.second) / (spanMs / HOUR_MS)).toFloat()
        if (perHour <= 0f) return QuotaBurn(0f, null, false)
        val outInMs = Math.round((100f - window.usedPercent) / perHour * HOUR_MS)
        return QuotaBurn(perHour, outInMs, now + outInMs < window.resetsAtEpochMs)
    }

    /** "12%/h · out in 3h 20m", or "lasts to reset" when the burn is flat or slow enough. */
    fun label(burn: QuotaBurn?): String? {
        burn ?: return null
        val rate = Math.round(burn.perHour)
        if (burn.outInMs == null || !burn.beforeReset) {
            return if (rate > 0) "$rate%/h · lasts to reset" else "lasts to reset"
        }
        return "$rate%/h · out in ${formatSpan(burn.outInMs)}"
    }

    private fun SessionQuotaUsage.window(key: QuotaWindowKey) = if (key == QuotaWindowKey.FiveHour) fiveHour else weekly
    private fun QuotaHistoryPoint.used(key: QuotaWindowKey) = if (key == QuotaWindowKey.FiveHour) fiveHour else weekly
}

/** "3h 20m", "2d 4h", "12m", "<1m" — the desktop card's spans. */
internal fun formatSpan(ms: Long): String {
    val minutes = ms / 60_000L
    if (minutes < 1) return "<1m"
    val days = minutes / 1440
    val hours = (minutes % 1440) / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes % 60}m"
        else -> "${minutes}m"
    }
}
