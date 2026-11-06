package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.ui.components.SessionState

/**
 * The words under a session name, and the age beside it — mockup screen 1.
 *
 * Pure on purpose: the activity words, the idle age and the clock-skew clamp
 * are real decisions with real failure modes, so they live
 * here where they are testable, not inside a composable where they are not.
 * The screen resolves [Labels] from resources and reads the answers.
 */
object SessionRowText {

    /** Display words, resolved from resources by the caller. */
    class Labels(
        val working: String,
        val waitingApproval: String,
        val idle: String,
    )

    fun subLine(
        activity: SessionState,
        cliTypeName: String,
        age: String?,
        labels: Labels,
    ): String {
        val word = when (activity) {
            SessionState.Active -> labels.working
            SessionState.Waiting -> return labels.waitingApproval
            SessionState.Idle, SessionState.Flash ->
                // "Idle · now" would be a contradiction; an idle session was not
                // just active.
                return if (age == null || age == "now") labels.idle else "${labels.idle} · $age"
        }

        return if (cliTypeName.isEmpty()) word else "$word · $cliTypeName"
    }

    /**
     * "now", "3m", "1h", "2d" — or null when nothing is known. Ages are clamped
     * at zero because `at` comes from the DESKTOP clock and `now` from the phone
     * one, and the two disagree in the wild (65 s of skew on the audit tablet);
     * a negative age would render as "-1m".
     */
    fun relativeTime(atEpochMs: Long?, nowMs: Long): String? {
        if (atEpochMs == null) return null

        val ageMs = (nowMs - atEpochMs).coerceAtLeast(0)
        val minutes = ageMs / 60_000
        return when {
            minutes < 2 -> "now"
            minutes < 60 -> "${minutes}m"
            minutes < 24 * 60 -> "${minutes / 60}h"
            else -> "${minutes / (24 * 60)}d"
        }
    }

    /**
     * The mission as the row's ticker line: one line, whitespace collapsed (a
     * mission may carry newlines), or null so a session without one keeps the
     * compact two-line row.
     */
    fun missionLine(mission: String?): String? =
        mission?.trim()?.replace(WHITESPACE, " ")?.takeIf { it.isNotEmpty() }

    /**
     * Line two of a row: status, then branch, then mission. The mission goes last
     * because it is the longest and most disposable part — when the line does not
     * fit, the ellipsis eats the mission, never the state.
     */
    fun detailLine(status: String, branch: String?, mission: String?): String =
        listOfNotNull(status, branch?.trim()?.takeIf { it.isNotEmpty() }, missionLine(mission))
            .joinToString(SEPARATOR)

    private const val SEPARATOR = " · "

    private val WHITESPACE = Regex("\\s+")
}
