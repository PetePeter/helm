package com.potatomotato.helm.data

import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.wire.WireShape
import org.json.JSONArray
import org.json.JSONObject

/**
 * One Helm session as the phone knows it — the subset of the desktop's
 * `SessionSummary` that screen 1 actually draws, and nothing more.
 */
data class HelmSession(
    val id: String,
    val name: String,
    /** Absolute project or working directory. The grouping KEY, not the label. */
    val projectPath: String,
    /**
     * The CLI's wire id (`claudecode`, `codex`, …), as opposed to its label.
     * Carried because the spawn form needs a cliType to send and there is no
     * phone-callable tool that enumerates them — the CLIs already running are the
     * only honest source, so a phone can only spawn a kind of session it can see.
     */
    val cliType: String,
    val cliTypeName: String,
    val activity: SessionState,
    /** The session's own AIAGENT-* phase, when it has declared one. */
    val aiagentState: String? = null,
    /** Something is waiting for the user's answer. Outranks every other status. */
    val questionPending: Boolean = false,
    /**
     * Desktop-clock epoch ms of the last activity — display-only (the phone clock
     * and the desktop clock disagree in the wild), and clamped at the reader.
     */
    val lastActiveAtEpochMs: Long? = null,

    /**
     * The plan this session has claimed, as the desktop's internal plan id. The
     * human id and title do NOT travel the session list, so the row can show
     * THAT a plan is claimed, never which one.
     */
    val currentPlanId: String? = null,
) {
    /**
     * What the group header shows. The full path is the identity — two projects
     * can share a last segment — but a phone screen has no room for it.
     */
    val projectLabel: String
        get() = lastPathSegment(projectPath)
}

/**
 * The `session_list` result, read off the wire.
 *
 * Tolerant by design and in one direction only: a field the desktop stops
 * sending must degrade to a sensible default, never drop the session or throw.
 * A phone that renders nothing because one row grew an unexpected value is worse
 * than a phone that renders that row as idle.
 */
object SessionWire {

    /**
     * Null when the payload is not a session list at all — and never silently:
     * an answer that arrived and could not be understood is indistinguishable
     * from an empty list to every layer above, so it says so.
     */
    fun parseList(result: Any?): List<HelmSession>? {
        val array = result as? JSONArray
            ?: return WireShape.undecodable("a session_list result", "a JSON array", result)
        return (0 until array.length()).mapNotNull { parse(array.optJSONObject(it)) }
    }

    private fun parse(summary: JSONObject?): HelmSession? {
        val id = summary?.opt("id") as? String ?: return null
        return HelmSession(
            id = id,
            name = summary.opt("name") as? String ?: id,
            projectPath = summary.opt("projectPath") as? String
                ?: summary.opt("workingDir") as? String
                ?: "",
            cliType = summary.opt("cliType") as? String ?: "",
            cliTypeName = summary.opt("cliTypeName") as? String ?: "",
            activity = activityOf(summary.opt("activityLevel")),
            aiagentState = summary.opt("aiagentState") as? String,
            questionPending = summary.opt("questionPending") == true,
            // org.json hands back Integer or Long by magnitude; both are the number.
            lastActiveAtEpochMs = (summary.opt("lastActiveAtEpochMs") as? Number)?.toLong(),
            currentPlanId = summary.opt("currentPlanId") as? String,
        )
    }

    /**
     * The dot reads ACTIVITY, never pipeline state (invariant 8) — which is why
     * this maps `activityLevel` and deliberately ignores `state`.
     *
     * The desktop's `inactive` is the phone's [SessionState.Waiting]: same
     * meaning (quiet, but recently alive), different word, and the desktop's is
     * the older one. Anything unrecognised — including a level a future Helm
     * invents — falls back to idle rather than crashing the list.
     */
    private fun activityOf(level: Any?): SessionState = when (level) {
        "active" -> SessionState.Active
        "inactive" -> SessionState.Waiting
        else -> SessionState.Idle
    }
}
