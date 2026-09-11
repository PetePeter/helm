package com.potatomotato.helm.data

import com.potatomotato.helm.ui.components.SessionState
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
    val cliTypeName: String,
    val activity: SessionState,
) {
    /**
     * What the group header shows. The full path is the identity — two projects
     * can share a last segment — but a phone screen has no room for it.
     */
    val projectLabel: String
        get() = projectPath.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
            .ifEmpty { projectPath }
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

    /** Null when the payload is not a session list at all. */
    fun parseList(result: Any?): List<HelmSession>? {
        val array = result as? JSONArray ?: return null
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
            cliTypeName = summary.opt("cliTypeName") as? String ?: "",
            activity = activityOf(summary.opt("activityLevel")),
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
