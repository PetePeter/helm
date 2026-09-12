package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.ui.components.SessionState

/**
 * The words under a session name, and the age beside it — mockup screen 1.
 *
 * Pure on purpose: the branch order (a pending question outranks everything),
 * the fallbacks (an unknown aiagent state degrades to the activity word), and
 * the clock-skew clamp are real decisions with real failure modes, so they live
 * here where they are testable, not inside a composable where they are not.
 * The screen resolves [Labels] from resources and reads the answers.
 */
object SessionRowText {

    /** Display words, resolved from resources by the caller. */
    class Labels(
        val needsDecision: String,
        val working: String,
        val waitingApproval: String,
        val idle: String,
        val planning: String,
        val implementing: String,
        val completed: String,
    )

    fun subLine(
        activity: SessionState,
        questionPending: Boolean,
        aiagentState: String?,
        cliTypeName: String,
        age: String?,
        labels: Labels,
    ): String {
        if (questionPending) return labels.needsDecision

        val agentWord = when (aiagentState) {
            "planning" -> labels.planning
            "implementing" -> labels.implementing
            "completed" -> labels.completed
            "idle" -> labels.idle
            else -> null
        } ?: when (activity) {
            SessionState.Active -> labels.working
            SessionState.Waiting -> return labels.waitingApproval
            SessionState.Idle, SessionState.Flash ->
                // "Idle · now" would be a contradiction; an idle session was not
                // just active.
                return if (age == null || age == "now") labels.idle else "${labels.idle} · $age"
        }

        return if (cliTypeName.isEmpty()) agentWord else "$agentWord · $cliTypeName"
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
}
