package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * A plan's lifecycle state, as the desktop's `PlanStatus` union names it.
 *
 * [Unknown] exists because a status this build has never met must not cost the
 * reader the plan: a desktop that grows a seventh state still answers six the
 * phone understands, and refusing the whole list over one string would trade
 * N-1 readable plans for a purity nobody asked for. It sorts LAST, after every
 * known state, for the same reason an unknown thing belongs at the bottom of a
 * list rather than the top of it.
 */
enum class PlanStatus(val wire: String) {
    Planning("planning"),
    Ready("ready"),
    Coding("coding"),
    Review("review"),
    Blocked("blocked"),
    Done("done"),
    Unknown("");

    companion object {
        /** The wire value, or [Unknown] for an absent or unrecognised one. */
        fun of(raw: String?): PlanStatus =
            entries.firstOrNull { it != Unknown && it.wire == raw } ?: Unknown
    }
}

/**
 * One ROW of a directory's plan board, as `plan_summary` answers it.
 *
 * THE DESCRIPTION IS NOT HERE, and that is the entire reason this type exists.
 * The full-record list tool answers every plan's whole prose: for Helm's own
 * project that is a 419 KB reply, and the phone link frames it in 512-byte
 * chunks, so the link died mid-transfer and the board only ever saw a timeout.
 * A board needs a title, a status and a place in the graph; the prose belongs on
 * the detail screen, one plan at a time, which is what [HelmPlan] is for.
 *
 * [sequenceId] is the lane this plan belongs to, which the board groups by. It
 * rides this answer because the board has no other source for it: the full
 * records are the very thing this type exists to avoid asking for.
 *
 * [blockedBy] and [blocks] are the desktop's HUMAN ids (P-00xx) — the plans this
 * one waits on, and the plans waiting on it — resolved against the full item set
 * rather than the filtered one, so an edge still names its far end even when the
 * filter excluded it. Startability is read off them; see `PlanStartability`.
 *
 * [sessionId] is the session that claimed the plan, and [sessionName] is that
 * session's display name. The name is absent when the session has gone.
 */
data class HelmPlanSummary(
    val id: String,
    val humanId: String?,
    val title: String,
    val type: String?,
    val status: PlanStatus,
    val stateUpdatedAtEpochMs: Long?,
    val sequenceId: String?,
    val blockedBy: List<String>,
    val blocks: List<String>,
    val sessionId: String? = null,
    val sessionName: String? = null,
)

/**
 * One plan item of a directory's DAG in FULL, as `plan_get` answers it — the
 * detail screen's type, and the only place the description is carried.
 *
 * Every field the desktop marks optional is nullable HERE too rather than being
 * defaulted to something plausible: `humanId` absent means this plan has no
 * P-00xx name yet, and inventing one would put a label on screen that no other
 * surface would agree with.
 */
data class HelmPlan(
    val id: String,
    val humanId: String?,
    val projectId: String?,
    val dirPath: String,
    val title: String,
    val description: String,
    val status: PlanStatus,
    val stateInfo: String?,
    val completionNotes: String?,
    val type: String?,
    val autoImplement: Boolean?,
    val completionRecap: Boolean?,
    val sequenceId: String?,
    val sessionId: String?,
    val createdAtEpochMs: Long,
    val stateUpdatedAtEpochMs: Long?,
    val updatedAtEpochMs: Long,
)

/**
 * One effective context reference of a plan, as `plan_context_list` answers it:
 * the plan's own bindings merged with those inherited from its sequence, with
 * [source] (`plan`, `sequence` or `both`) saying which. The CONTENT is not here
 * — that is a `context_get` away, fetched just-in-time, which is the whole
 * point of the refs being a separate and much smaller answer.
 */
data class HelmPlanContextRef(
    val id: String,
    val type: String,
    val source: String,
)

/**
 * The state of one directory's plan list.
 *
 * [Refreshing] is what a re-visit looks like when the directory has been listed
 * before — the same discipline `ArtifactList` keeps, and for the same reason:
 * the rows the user is looking at are the best-known truth and a blank screen
 * is the worst one.
 */
sealed interface PlanList {
    data object Idle : PlanList
    data class Loading(val dirPath: String) : PlanList

    /** A fresh ask in flight; [cached] is what the last answer for the directory said. */
    data class Refreshing(val dirPath: String, val cached: List<HelmPlanSummary>) : PlanList
    data class Ready(val dirPath: String, val plans: List<HelmPlanSummary>) : PlanList
    data class Failed(val dirPath: String, val message: String) : PlanList
}

/** The state of one plan's full detail, as the plan screen draws it. */
sealed interface PlanDetail {
    data object Idle : PlanDetail
    data class Loading(val planId: String) : PlanDetail
    data class Refreshing(val planId: String, val cached: HelmPlan) : PlanDetail
    data class Ready(val plan: HelmPlan) : PlanDetail
    data class Failed(val planId: String, val message: String) : PlanDetail
}

/** The state of one plan's effective context refs. */
sealed interface PlanContextRefs {
    data object Idle : PlanContextRefs
    data class Loading(val planId: String) : PlanContextRefs
    data class Refreshing(val planId: String, val cached: List<HelmPlanContextRef>) : PlanContextRefs
    data class Ready(val planId: String, val refs: List<HelmPlanContextRef>) : PlanContextRefs
    data class Failed(val planId: String, val message: String) : PlanContextRefs
}

/**
 * PlanRepository — the phone's picture of Helm's directory plans.
 *
 * Pulled on demand, never streamed, exactly like the artifacts: the link's frame
 * budget is the scarce thing, and a plan screen asks once per visit.
 *
 * KEYED BY dirPath, not by "the current directory". Two plan surfaces can be
 * live at once — the top-level plan board and an in-session view of the
 * session's own directory — and a single unkeyed cache would have each visit
 * quietly overwrite the other's rows. The state machines still hold one ask at
 * a time (there is one screen in front of the user), but every arrival is
 * CHECKED AGAINST THE ASK and a late answer for a superseded key is DROPPED,
 * which is what keeps the two scopes from clobbering each other.
 *
 * THE FRONTIER IS NOT STORED HERE. Startability is read off the rows' own
 * `blockedBy` edges by `PlanStartability` at draw time, which is one ask instead
 * of two — the separate `filter=startable` call it replaced was a second whole
 * round trip for a fact the rows already carry.
 *
 * Caches obey the artifact repository's OMISSION-ONLY PURGE: an entry leaves
 * only when a fresh, parsed answer for its key demonstrably omits it. A failed
 * refresh, an undecodable answer or a dropped link never evict anything.
 *
 * Deliberately free of Android types, like every other repository here.
 */
class PlanRepository {
    private val _list = MutableStateFlow<PlanList>(PlanList.Idle)
    val list: StateFlow<PlanList> = _list.asStateFlow()

    private val _detail = MutableStateFlow<PlanDetail>(PlanDetail.Idle)
    val detail: StateFlow<PlanDetail> = _detail.asStateFlow()

    private val _contextRefs = MutableStateFlow<PlanContextRefs>(PlanContextRefs.Idle)
    val contextRefs: StateFlow<PlanContextRefs> = _contextRefs.asStateFlow()

    /** Last parsed list answer per directory — what a re-visit shows while it refreshes. */
    private val listCache = HashMap<String, List<HelmPlanSummary>>()

    /** Last parsed plan per id — what re-opening a plan shows while it refreshes. */
    private val detailCache = HashMap<String, HelmPlan>()

    /** Last parsed context refs per plan id. */
    private val refsCache = HashMap<String, List<HelmPlanContextRef>>()

    // THE ASK, REMEMBERED — not read back off the current state.
    //
    // Deriving it from the state was a hole: Ready, Failed and Idle carry no ask,
    // so a slow answer for a SUPERSEDED key arriving after the newer one had
    // already settled saw "nothing asked" and was applied. The state then
    // described directory A while the screen was showing directory B, and
    // `LoadViews.scoped` — correctly refusing to draw A's rows under B's heading
    // — left B on a spinner with nothing in flight and no retry.
    //
    // A field survives settling, so the LAST key requested is always the one an
    // arrival is judged against. Null only before the very first ask, where any
    // answer is as good as none.
    private var askedListDirPath: String? = null
    private var askedDetailPlanId: String? = null
    private var askedRefsPlanId: String? = null

    /** The cached plans of a directory, when it has been listed before; empty otherwise. */
    fun cachedPlans(dirPath: String): List<HelmPlanSummary> = listCache[dirPath].orEmpty()

    /**
     * An ask for a directory's plans. A directory with a cache shows it
     * ([PlanList.Refreshing]); a first visit waits ([PlanList.Loading]).
     */
    fun listRequested(dirPath: String) {
        askedListDirPath = dirPath
        val cached = listCache[dirPath]
        _list.value = if (cached != null) {
            PlanList.Refreshing(dirPath, cached)
        } else {
            PlanList.Loading(dirPath)
        }
    }

    /**
     * Take a `plan_summary` result — a JSON array of plan rows. True when the ask
     * is settled: applied, or a stale arrival for ANOTHER directory dropped,
     * since the newer ask still owns the state. False when the answer arrived
     * and could not be read, which the caller turns into a failure.
     */
    fun listArrived(dirPath: String, result: Any?): Boolean {
        val asked = askedListDirPath
        if (asked != null && asked != dirPath) return true

        val parsed = parseSummaries(result) ?: return false
        // A plan the directory no longer names is a plan that is gone, which is
        // the one fact that outranks a cached detail or its context refs. WHICH
        // plans the directory used to name comes from the outgoing cache rather
        // than from a `dirPath` on the row: the summary answer does not carry
        // one, and a plan can only have been listed here if it was in this
        // directory's last answer.
        val live = parsed.map { it.id }.toSet()
        val leaving = listCache[dirPath].orEmpty().map { it.id }.filter { it !in live }.toSet()
        // Replacement IS the purge: what the fresh answer omits leaves the cache.
        listCache[dirPath] = parsed
        detailCache.keys.removeAll(leaving)
        refsCache.keys.removeAll(leaving)
        _list.value = PlanList.Ready(dirPath, parsed)
        return true
    }

    /** Record why the plans are missing. The message is what the user reads. */
    fun listFailed(dirPath: String, message: String) {
        // The cache stands: a failed ask is no evidence a plan left.
        _list.value = PlanList.Failed(dirPath, message)
    }

    /** An ask for one plan's full detail. */
    fun detailRequested(planId: String) {
        askedDetailPlanId = planId
        val cached = detailCache[planId]
        _detail.value = if (cached != null) {
            PlanDetail.Refreshing(planId, cached)
        } else {
            PlanDetail.Loading(planId)
        }
    }

    /**
     * Take a `plan_get` result — one plan object. Same contract as every other
     * arrival: true when settled (applied, or a stale arrival for another plan
     * dropped), false when the answer could not be read.
     */
    fun detailArrived(planId: String, result: Any?): Boolean {
        val asked = askedDetailPlanId
        if (asked != null && asked != planId) return true

        val plan = parsePlan(result as? JSONObject) ?: run {
            WireShape.undecodable<Unit>("a plan_get result", "a JSON object with an `id` string", result)
            return false
        }
        detailCache[planId] = plan
        _detail.value = PlanDetail.Ready(plan)
        return true
    }

    /** Record why the plan is missing. The message is what the user reads. */
    fun detailFailed(planId: String, message: String) {
        _detail.value = PlanDetail.Failed(planId, message)
    }

    /** An ask for one plan's effective context refs. */
    fun contextRefsRequested(planId: String) {
        askedRefsPlanId = planId
        val cached = refsCache[planId]
        _contextRefs.value = if (cached != null) {
            PlanContextRefs.Refreshing(planId, cached)
        } else {
            PlanContextRefs.Loading(planId)
        }
    }

    /** Take a `plan_context_list` result — a JSON array of `{id, type, source}`. */
    fun contextRefsArrived(planId: String, result: Any?): Boolean {
        val asked = askedRefsPlanId
        if (asked != null && asked != planId) return true

        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a plan_context_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { index ->
            val ref = array.optJSONObject(index)
            val id = ref?.opt("id") as? String ?: return@mapNotNull null
            HelmPlanContextRef(
                id = id,
                type = ref.opt("type") as? String ?: "",
                source = ref.opt("source") as? String ?: "",
            )
        }
        refsCache[planId] = parsed
        _contextRefs.value = PlanContextRefs.Ready(planId, parsed)
        return true
    }

    /** Record why the refs are missing. The message is what the user reads. */
    fun contextRefsFailed(planId: String, message: String) {
        _contextRefs.value = PlanContextRefs.Failed(planId, message)
    }

    /**
     * A `plan_delete` the desktop confirmed. This is the one write that purges
     * WITHOUT waiting for an omitting list answer: the desktop has said the plan
     * is gone, which is the same evidence an omission is, and the board would
     * otherwise show a deleted row until the refresh lands. Only called on
     * success — a failed delete leaves every cache as it was.
     */
    fun planDeleted(planId: String) {
        for (dirPath in listCache.keys.toList()) {
            listCache[dirPath] = listCache.getValue(dirPath).filter { it.id != planId }
        }
        detailCache.remove(planId)
        refsCache.remove(planId)
        _list.value = when (val current = _list.value) {
            is PlanList.Ready -> current.copy(plans = current.plans.filter { it.id != planId })
            is PlanList.Refreshing -> current.copy(cached = current.cached.filter { it.id != planId })
            else -> current
        }
    }

    private fun parseSummaries(result: Any?): List<HelmPlanSummary>? {
        val array = result as? JSONArray ?: return WireShape.undecodable(
            "a plan_summary result",
            "a JSON array",
            result,
        )
        return (0 until array.length()).mapNotNull { parseSummary(array.optJSONObject(it)) }
    }

    /** One board row. A row without an id is dropped rather than invented. */
    private fun parseSummary(entry: JSONObject?): HelmPlanSummary? {
        val id = entry?.opt("id") as? String ?: return null
        return HelmPlanSummary(
            id = id,
            humanId = entry.opt("humanId") as? String,
            title = entry.opt("title") as? String ?: id,
            type = entry.opt("type") as? String,
            status = PlanStatus.of(entry.opt("status") as? String),
            stateUpdatedAtEpochMs = (entry.opt("stateUpdatedAt") as? Number)?.toLong(),
            sequenceId = entry.opt("sequenceId") as? String,
            blockedBy = parseIds(entry.optJSONArray("blockedBy")),
            blocks = parseIds(entry.optJSONArray("blocks")),
            sessionId = entry.opt("sessionId") as? String,
            sessionName = entry.opt("sessionName") as? String,
        )
    }

    /** An edge list of P-00xx ids; a non-string entry is not an id and is dropped. */
    private fun parseIds(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { array.opt(it) as? String }
    }

    /** One full plan. A plan without an id is dropped rather than invented. */
    private fun parsePlan(entry: JSONObject?): HelmPlan? {
        val id = entry?.opt("id") as? String ?: return null
        return HelmPlan(
            id = id,
            humanId = entry.opt("humanId") as? String,
            projectId = entry.opt("projectId") as? String,
            dirPath = entry.opt("dirPath") as? String ?: "",
            title = entry.opt("title") as? String ?: id,
            description = entry.opt("description") as? String ?: "",
            status = PlanStatus.of(entry.opt("status") as? String),
            stateInfo = entry.opt("stateInfo") as? String,
            completionNotes = entry.opt("completionNotes") as? String,
            type = entry.opt("type") as? String,
            autoImplement = entry.opt("autoImplement") as? Boolean,
            completionRecap = entry.opt("completionRecap") as? Boolean,
            sequenceId = entry.opt("sequenceId") as? String,
            sessionId = entry.opt("sessionId") as? String,
            // org.json hands back Integer or Long by magnitude; both are the number.
            createdAtEpochMs = (entry.opt("createdAt") as? Number)?.toLong() ?: 0L,
            stateUpdatedAtEpochMs = (entry.opt("stateUpdatedAt") as? Number)?.toLong(),
            updatedAtEpochMs = (entry.opt("updatedAt") as? Number)?.toLong() ?: 0L,
        )
    }
}
