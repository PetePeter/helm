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
     * Carried for the spawn form's FALLBACK: when the `tool_list` catalogue
     * cannot be fetched, the CLIs already running are the only honest source,
     * so the form can only offer a kind of session it can see.
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
    /** The session's mission TL;DR (desktop caps it at 500 chars); null when unset or blank. */
    val mission: String? = null,
    /** The desktop's session role — `operator` marks the one "Helm" session. Null for every other. */
    val role: String? = null,
    /**
     * Set on a Remote row: the name of the machine the CLI really runs on (the
     * desktop only views it). Null for the desktop's own sessions.
     */
    val machineName: String? = null,
    /** An API-tool session: Helm hosts the agent loop itself (no CLI). */
    val apiTool: Boolean = false,
    /** Helm hosts ComfyUI generation and routes this session through chat. */
    val comfyUiTool: Boolean = false,
    val comfyUiProfiles: List<ComfyUiProfile> = emptyList(),
    val comfyUiImageSizes: List<ComfyUiImageSize> = emptyList(),
    /** Set on a subagent: the session whose Agent call spawned it. Such rows are never listed. */
    val subagentOf: String? = null,
    /** Subagents this session is waiting on right now — drawn as a 🔥 count. */
    val pendingSubagents: Int = 0,
    /** Refuses all input until thawed (docs/session-freeze.md). */
    val frozen: Boolean = false,
    /** Protected from closure. */
    val locked: Boolean = false,
    /** Desktop-clock epoch ms until which keep-warm pings run; null when off. */
    val keepWarmUntilEpochMs: Long? = null,
    /** Desktop-clock epoch ms of the last prompt — the clock the cache windows count from. */
    val lastPromptAtEpochMs: Long? = null,
    /** The CLI type's short / long prompt-cache windows, in minutes. */
    val cacheWarnMinutes: Int = 5,
    val cacheExpireMinutes: Int = 60,
    /** A local model: no prompt cache, so the session never goes stale. */
    val noPromptCache: Boolean = false,
    /** Current git branch when the session's local working directory has one. */
    val gitBranch: String? = null,
) {
    /** Lock / frozen / keep-warm, as the desktop row shows them — every one that applies. */
    fun statusIcons(nowMs: Long): String = listOfNotNull(
        "🔒".takeIf { locked },
        "❄️".takeIf { frozen },
        "⏰".takeIf { (keepWarmUntilEpochMs ?: 0L) > nowMs },
    ).joinToString(" ")

    /**
     * How stale the session's prompt cache is. The desktop clock and the phone
     * clock can disagree, so this is a warning, never a gate — the desktop owns
     * the actual freeze. The operator is never frozen and must always answer,
     * so a cold cache is not worth warning about; nor is one with no prompt cache.
     */
    fun cacheStage(nowMs: Long): CacheStage {
        if (frozen) return CacheStage.Frozen
        if (role == "operator" || noPromptCache) return CacheStage.Fresh
        val age = nowMs - (lastPromptAtEpochMs ?: return CacheStage.Fresh)
        return when {
            age > cacheExpireMinutes * 60_000L -> CacheStage.Expired
            age > cacheWarnMinutes * 60_000L -> CacheStage.Warn
            else -> CacheStage.Fresh
        }
    }

    /**
     * What the group header shows. The full path is the identity — two projects
     * can share a last segment — but a phone screen has no room for it.
     */
    val projectLabel: String
        get() = lastPathSegment(projectPath)

    /**
     * The list header this row sits under: its project for the desktop's own
     * sessions, its machine for a Remote row — a peer's path means nothing next
     * to this desktop's project folders.
     */
    val groupLabel: String
        get() = machineName?.let { "🖥 $it" } ?: projectLabel
}

enum class CacheStage { Fresh, Warn, Expired, Frozen }

data class ComfyUiProfile(val id: String, val name: String, val kind: String, val supportsImageSize: Boolean = false, val maxReferenceImages: Int = 1)
data class ComfyUiImageSize(val id: String, val name: String, val width: Int, val height: Int)

/**
 * Where this phone has got to in Helm's session change feed. [epoch] names one
 * run of Helm: a cursor from another run is answered with the whole list.
 */
data class SessionCursor(val epoch: String, val seq: Long)

/**
 * One `session_list` answer. [full] means [sessions] is the whole list and
 * replaces what is held; otherwise [sessions] are only the rows that changed
 * and [removed] the ids that went away.
 */
data class SessionChanges(
    val cursor: SessionCursor?,
    val full: Boolean,
    val sessions: List<HelmSession>,
    val removed: List<String> = emptyList(),
)

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
        return visible((0 until array.length()).mapNotNull { parse(array.optJSONObject(it)) })
    }

    /**
     * The `session_list` DELTA reply — `{epoch, seq, full, sessions, removed}` —
     * which is what Helm answers when the call carries `since`.
     *
     * A bare array is still read, as a whole list with no cursor: it is what a
     * call without `since` gets, and reading it costs nothing.
     *
     * A row that is a subagent is reported as REMOVED rather than dropped: in a
     * delta, "not listed" means "unchanged", so a session that became one would
     * otherwise stay on screen.
     */
    fun parseChanges(result: Any?): SessionChanges? {
        if (result is JSONArray) return parseList(result)?.let { SessionChanges(cursor = null, full = true, sessions = it) }
        val reply = result as? JSONObject
            ?: return WireShape.undecodable("a session_list result", "a JSON object or array", result)
        val rows = reply.opt("sessions") as? JSONArray
            ?: return WireShape.undecodable("a session_list result", "a sessions array", result)
        val epoch = reply.opt("epoch") as? String
        val seq = (reply.opt("seq") as? Number)?.toLong()
        val parsed = (0 until rows.length()).mapNotNull { parse(rows.optJSONObject(it)) }
        val gone = reply.opt("removed") as? JSONArray
        return SessionChanges(
            // A reply that cannot say where it got to is still a list; it just
            // cannot be resumed from, so the next fetch asks for everything.
            cursor = if (epoch != null && seq != null) SessionCursor(epoch, seq) else null,
            full = reply.opt("full") != false,
            sessions = visible(parsed),
            removed = (0 until (gone?.length() ?: 0)).mapNotNull { gone?.opt(it) as? String } +
                parsed.filter { it.subagentOf != null }.map { it.id },
        )
    }

    /**
     * Subagents are their parent's business: the parent shows a 🔥 count, the
     * subagent sessions themselves appear in no list or picker. Filtered once,
     * here, so every screen that lists sessions agrees.
     */
    fun visible(sessions: List<HelmSession>): List<HelmSession> = sessions.filter { it.subagentOf == null }

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
            gitBranch = (summary.opt("gitBranch") as? String)?.takeIf { it.isNotBlank() },
            activity = activityOf(summary.opt("activityLevel")),
            aiagentState = summary.opt("aiagentState") as? String,
            questionPending = summary.opt("questionPending") == true,
            // org.json hands back Integer or Long by magnitude; both are the number.
            lastActiveAtEpochMs = (summary.opt("lastActiveAtEpochMs") as? Number)?.toLong(),
            currentPlanId = summary.opt("currentPlanId") as? String,
            mission = ((summary.opt("mission") as? JSONObject)?.opt("text") as? String)
                ?.takeIf { it.isNotBlank() },
            role = (summary.opt("role") as? String)?.takeIf { it.isNotBlank() },
            machineName = ((summary.opt("remote") as? JSONObject)?.opt("machineName") as? String)
                ?.takeIf { it.isNotBlank() },
            apiTool = summary.opt("apiTool") == true,
            comfyUiTool = summary.opt("comfyUiTool") == true,
            comfyUiProfiles = (summary.optJSONArray("comfyUiProfiles")?.let { profiles ->
                (0 until profiles.length()).mapNotNull { index ->
                    val profile = profiles.optJSONObject(index) ?: return@mapNotNull null
                    val profileId = profile.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    val kind = profile.optString("kind").takeIf { it == "image" || it == "video" } ?: return@mapNotNull null
                    val label = profile.optString("name").takeIf { it.isNotBlank() } ?: profileId
                    ComfyUiProfile(
                        profileId, label, kind, profile.opt("supportsImageSize") == true,
                        (profile.opt("maxReferenceImages") as? Number)?.toInt()?.coerceIn(1, 16) ?: 1,
                    )
                }
            } ?: emptyList()),
            comfyUiImageSizes = (summary.optJSONArray("comfyUiImageSizes")?.let { sizes ->
                (0 until sizes.length()).mapNotNull { index ->
                    val size = sizes.optJSONObject(index) ?: return@mapNotNull null
                    val sizeId = size.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    val name = size.optString("name").takeIf { it.isNotBlank() } ?: sizeId
                    val width = (size.opt("width") as? Number)?.toInt()?.takeIf { it > 0 } ?: return@mapNotNull null
                    val height = (size.opt("height") as? Number)?.toInt()?.takeIf { it > 0 } ?: return@mapNotNull null
                    ComfyUiImageSize(sizeId, name, width, height)
                }
            } ?: emptyList()),
            subagentOf = (summary.opt("subagentOf") as? String)?.takeIf { it.isNotBlank() },
            pendingSubagents = ((summary.opt("pendingSubagents") as? Number)?.toInt() ?: 0).coerceAtLeast(0),
            frozen = summary.opt("frozen") == true,
            locked = summary.opt("locked") == true,
            keepWarmUntilEpochMs = (summary.opt("keepWarmUntilEpochMs") as? Number)?.toLong(),
            lastPromptAtEpochMs = (summary.opt("lastPromptAtEpochMs") as? Number)?.toLong(),
            cacheWarnMinutes = (summary.opt("cacheWarnMinutes") as? Number)?.toInt()?.takeIf { it > 0 } ?: 5,
            cacheExpireMinutes = (summary.opt("cacheExpireMinutes") as? Number)?.toInt()?.takeIf { it > 0 } ?: 60,
            noPromptCache = summary.opt("noPromptCache") == true,
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
