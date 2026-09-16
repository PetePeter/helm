package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * One project Helm tracks, as `project_list` answers it.
 *
 * It lives in this file rather than one of its own because a projectId is not
 * useful on its own — it is the KEY every context call needs, and the desktop's
 * own tool description says so ("use project_list first when you need the
 * projectId"). Keeping the id and the thing it unlocks together is one fact in
 * one place; a fourth repository whose only reader is this one would not be.
 */
data class HelmProject(
    val id: String,
    val name: String,
    val canonicalPath: String,
)

/**
 * A context node's write permission, as the desktop's `ContextPermission` union
 * names it. There is no Unknown member: the desktop answers exactly two values,
 * and the SAFE reading of an unrecognised third is [Readonly] — claiming a
 * writable node the desktop never said was writable is the one mistake that
 * would matter, and this phase writes nothing anyway.
 */
enum class ContextPermission(val wire: String) {
    Readonly("readonly"),
    Writable("writable");

    companion object {
        fun of(raw: String?): ContextPermission = if (raw == Writable.wire) Writable else Readonly
    }
}

/**
 * One project-level context node, as `context_list` and `context_get` answer it.
 *
 * [type] is the desktop's free-text classification (`Testing`, `Coding`, … and
 * whatever a user typed) rather than an enum, because the desktop treats it as
 * free text and an enum here would refuse a node over its label.
 *
 * [x] and [y] are nullable on the wire — a node the user never dragged has no
 * stored position — and stay nullable here so nothing invents an origin.
 *
 * [content] is the full body. `context_list` answers it too, which is why there
 * is no separate "metadata only" shape: the desktop decided the list is cheap.
 */
data class HelmContext(
    val id: String,
    val projectId: String,
    val title: String,
    val type: String,
    val permission: ContextPermission,
    val content: String,
    val x: Double?,
    val y: Double?,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

/**
 * The state of the project list. Unkeyed — there is exactly one projects answer
 * per desktop — which is why it alone carries no scope on its states.
 */
sealed interface ProjectList {
    data object Idle : ProjectList
    data object Loading : ProjectList

    /** A fresh ask in flight; [cached] is what the last answer said. */
    data class Refreshing(val cached: List<HelmProject>) : ProjectList
    data class Ready(val projects: List<HelmProject>) : ProjectList
    data class Failed(val message: String) : ProjectList
}

/** The state of one project's context nodes. */
sealed interface ContextList {
    data object Idle : ContextList
    data class Loading(val projectId: String) : ContextList

    /** A fresh ask in flight; [cached] is what the last answer for the project said. */
    data class Refreshing(val projectId: String, val cached: List<HelmContext>) : ContextList
    data class Ready(val projectId: String, val contexts: List<HelmContext>) : ContextList
    data class Failed(val projectId: String, val message: String) : ContextList
}

/** The state of one context node read in full, as the context screen draws it. */
sealed interface ContextDetail {
    data object Idle : ContextDetail
    data class Loading(val contextId: String) : ContextDetail
    data class Refreshing(val contextId: String, val cached: HelmContext) : ContextDetail
    data class Ready(val context: HelmContext) : ContextDetail
    data class Failed(val contextId: String, val message: String) : ContextDetail
}

/**
 * ContextRepository — the phone's picture of Helm's project context nodes, and
 * of the projects they hang from.
 *
 * KEYED BY projectId, not by "the current project": a top-level context browser
 * and an in-session view of the session's project can be live at once, and one
 * unkeyed cache would have each overwrite the other. Late answers for a
 * superseded key are DROPPED, not applied.
 *
 * READ-ONLY by design in this phase. There are no create/update/delete methods
 * here, so nothing above this layer can accidentally offer a write the screens
 * were never designed to confirm.
 *
 * Same OMISSION-ONLY PURGE as every other cache here: a node leaves only when a
 * fresh parsed answer for its project omits it.
 */
class ContextRepository {
    private val _projects = MutableStateFlow<ProjectList>(ProjectList.Idle)
    val projects: StateFlow<ProjectList> = _projects.asStateFlow()

    private val _list = MutableStateFlow<ContextList>(ContextList.Idle)
    val list: StateFlow<ContextList> = _list.asStateFlow()

    private val _detail = MutableStateFlow<ContextDetail>(ContextDetail.Idle)
    val detail: StateFlow<ContextDetail> = _detail.asStateFlow()

    private var projectCache: List<HelmProject>? = null
    private val listCache = HashMap<String, List<HelmContext>>()
    private val detailCache = HashMap<String, HelmContext>()

    // The LAST key asked for, remembered rather than read back off the current
    // state. See [PlanRepository] for why a state-derived ask is a hole: a
    // settled state carries no key, so a superseded answer arriving after the
    // newer one landed would be applied and wedge the live surface on Loading.
    // The PROJECTS have no such field because they have no key: there is one
    // projects answer per desktop and nothing it could be stale about.
    private var askedListProjectId: String? = null
    private var askedDetailContextId: String? = null

    /** The cached nodes of a project, when it has been listed before; empty otherwise. */
    fun cachedContexts(projectId: String): List<HelmContext> = listCache[projectId].orEmpty()

    /** An ask for the projects; a re-visit shows the cache while it refreshes. */
    fun projectsRequested() {
        val cached = projectCache
        _projects.value = if (cached != null) ProjectList.Refreshing(cached) else ProjectList.Loading
    }

    /**
     * Take a `project_list` result — a JSON array of `{id, name, canonicalPath,
     * directories, rootKind}`. Only the three fields the phone shows are kept.
     */
    fun projectsArrived(result: Any?): Boolean {
        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a project_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index)
            val id = entry?.opt("id") as? String ?: return@mapNotNull null
            HelmProject(
                id = id,
                name = entry.opt("name") as? String ?: id,
                canonicalPath = entry.opt("canonicalPath") as? String ?: "",
            )
        }
        projectCache = parsed
        _projects.value = ProjectList.Ready(parsed)
        return true
    }

    /** Record why the projects are missing. The message is what the user reads. */
    fun projectsFailed(message: String) {
        _projects.value = ProjectList.Failed(message)
    }

    /** An ask for a project's context nodes; a re-visit shows its cache. */
    fun listRequested(projectId: String) {
        askedListProjectId = projectId
        val cached = listCache[projectId]
        _list.value = if (cached != null) {
            ContextList.Refreshing(projectId, cached)
        } else {
            ContextList.Loading(projectId)
        }
    }

    /**
     * Take a `context_list` result — a JSON array of context nodes. True when
     * settled (applied, or a stale arrival for another project dropped), false
     * when the answer could not be read.
     */
    fun listArrived(projectId: String, result: Any?): Boolean {
        val asked = askedListProjectId
        if (asked != null && asked != projectId) return true

        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a context_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { parseContext(array.optJSONObject(it)) }
        listCache[projectId] = parsed
        // A node the project no longer names is a node that is gone.
        val live = parsed.map { it.id }.toSet()
        detailCache.keys.removeAll(
            detailCache.filterValues { it.projectId == projectId && it.id !in live }.keys.toSet(),
        )
        _list.value = ContextList.Ready(projectId, parsed)
        return true
    }

    /** Record why the nodes are missing. The message is what the user reads. */
    fun listFailed(projectId: String, message: String) {
        _list.value = ContextList.Failed(projectId, message)
    }

    /** An ask for one node's full body. */
    fun detailRequested(contextId: String) {
        askedDetailContextId = contextId
        val cached = detailCache[contextId]
        _detail.value = if (cached != null) {
            ContextDetail.Refreshing(contextId, cached)
        } else {
            ContextDetail.Loading(contextId)
        }
    }

    /** Take a `context_get` result — one context node object. */
    fun detailArrived(contextId: String, result: Any?): Boolean {
        val asked = askedDetailContextId
        if (asked != null && asked != contextId) return true

        val context = parseContext(result as? JSONObject) ?: run {
            WireShape.undecodable<Unit>("a context_get result", "a JSON object with an `id` string", result)
            return false
        }
        detailCache[contextId] = context
        _detail.value = ContextDetail.Ready(context)
        return true
    }

    /** Record why the node is missing. The message is what the user reads. */
    fun detailFailed(contextId: String, message: String) {
        _detail.value = ContextDetail.Failed(contextId, message)
    }

    /** One node. A node without an id is dropped rather than invented. */
    private fun parseContext(entry: JSONObject?): HelmContext? {
        val id = entry?.opt("id") as? String ?: return null
        return HelmContext(
            id = id,
            projectId = entry.opt("projectId") as? String ?: "",
            title = entry.opt("title") as? String ?: id,
            type = entry.opt("type") as? String ?: "",
            permission = ContextPermission.of(entry.opt("permission") as? String),
            content = entry.opt("content") as? String ?: "",
            // JSON null and an absent key are both "never positioned"; org.json
            // hands the former back as JSONObject.NULL, which is not a Number.
            x = (entry.opt("x") as? Number)?.toDouble(),
            y = (entry.opt("y") as? Number)?.toDouble(),
            createdAtEpochMs = (entry.opt("createdAt") as? Number)?.toLong() ?: 0L,
            updatedAtEpochMs = (entry.opt("updatedAt") as? Number)?.toLong() ?: 0L,
        )
    }
}
