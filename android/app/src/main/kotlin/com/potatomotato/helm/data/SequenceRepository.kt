package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * One sequence coordination lane of a directory, as `sequence_list` and
 * `sequence_get` answer it.
 *
 * [memberPlanIds] and [memberHumanIds] are NOT fields of the desktop's stored
 * `PlanSequence` — the service computes them per answer — so they are the one
 * part of this shape that a future desktop could stop sending. They parse to
 * empty for exactly that reason: a lane with no member list is still a lane
 * worth drawing, and the plans' own `sequenceId` is the authority on membership
 * anyway.
 *
 * [sharedMemory] is the desktop's own legacy field. It is carried because it is
 * still answered and still readable; nothing here writes it.
 */
data class HelmPlanSequence(
    val id: String,
    val projectId: String?,
    val dirPath: String,
    val title: String,
    val missionStatement: String,
    val sharedMemory: String,
    val order: Int,
    val contextIds: List<String> = emptyList(),
    val memberPlanIds: List<String> = emptyList(),
    val memberHumanIds: List<String> = emptyList(),
    val createdAtEpochMs: Long = 0L,
    val updatedAtEpochMs: Long = 0L,
)

/** The state of one directory's sequence lanes. */
sealed interface SequenceList {
    data object Idle : SequenceList
    data class Loading(val dirPath: String) : SequenceList

    /** A fresh ask in flight; [cached] is what the last answer for the directory said. */
    data class Refreshing(val dirPath: String, val cached: List<HelmPlanSequence>) : SequenceList
    data class Ready(val dirPath: String, val sequences: List<HelmPlanSequence>) : SequenceList
    data class Failed(val dirPath: String, val message: String) : SequenceList
}

/** The state of one sequence's detail, as the sequence screen draws it. */
sealed interface SequenceDetail {
    data object Idle : SequenceDetail
    data class Loading(val sequenceId: String) : SequenceDetail
    data class Refreshing(val sequenceId: String, val cached: HelmPlanSequence) : SequenceDetail
    data class Ready(val sequence: HelmPlanSequence) : SequenceDetail
    data class Failed(val sequenceId: String, val message: String) : SequenceDetail
}

/** What a directory cleanup would remove, as `plan_cleanup_counts` answers it. */
data class CleanupCounts(
    val donePlans: Int,
    val emptySequences: Int,
    val unreferencedContexts: Int,
    /** What "Clear unused" deletes: unreferenced contexts plus those bound only to empty sequences. */
    val unusedContexts: Int,
) {
    /** Nothing for "Clear unused" to do — the button greys rather than asking to delete zero things. */
    val nothingToClear: Boolean get() = emptySequences == 0 && unusedContexts == 0
}

/** The cleanup counts of one directory. */
sealed interface CleanupState {
    data object Idle : CleanupState
    data class Loading(val dirPath: String) : CleanupState
    data class Ready(val dirPath: String, val counts: CleanupCounts) : CleanupState
    data class Failed(val dirPath: String, val message: String) : CleanupState
}

/**
 * SequenceRepository — the phone's picture of Helm's sequence lanes.
 *
 * KEYED BY dirPath for the same reason [PlanRepository] is: the lanes are what
 * the plan board groups by, so the two answers must be about the same scope or
 * the grouping is a lie, and two live scopes must not overwrite each other's
 * caches. Late answers for a superseded key are DROPPED, not applied.
 *
 * Same OMISSION-ONLY PURGE as every other cache here: a lane leaves only when a
 * fresh parsed answer for its directory omits it.
 */
class SequenceRepository {
    private val _list = MutableStateFlow<SequenceList>(SequenceList.Idle)
    val list: StateFlow<SequenceList> = _list.asStateFlow()

    private val _detail = MutableStateFlow<SequenceDetail>(SequenceDetail.Idle)
    val detail: StateFlow<SequenceDetail> = _detail.asStateFlow()

    private val _cleanup = MutableStateFlow<CleanupState>(CleanupState.Idle)
    val cleanup: StateFlow<CleanupState> = _cleanup.asStateFlow()

    private val listCache = HashMap<String, List<HelmPlanSequence>>()
    private val detailCache = HashMap<String, HelmPlanSequence>()

    // The LAST key asked for, remembered rather than read back off the current
    // state. See [PlanRepository] for why a state-derived ask is a hole: a
    // settled state carries no key, so a superseded answer arriving after the
    // newer one landed would be applied and wedge the live surface on Loading.
    private var askedListDirPath: String? = null
    private var askedDetailSequenceId: String? = null

    /** The cached lanes of a directory, when it has been listed before; empty otherwise. */
    fun cachedSequences(dirPath: String): List<HelmPlanSequence> = listCache[dirPath].orEmpty()

    /** An ask for a directory's lanes; a re-visit shows its cache while it refreshes. */
    fun listRequested(dirPath: String) {
        askedListDirPath = dirPath
        val cached = listCache[dirPath]
        _list.value = if (cached != null) {
            SequenceList.Refreshing(dirPath, cached)
        } else {
            SequenceList.Loading(dirPath)
        }
    }

    /**
     * Take a `sequence_list` result — a JSON array of lanes with their computed
     * member ids. True when settled (applied, or a stale arrival for another
     * directory dropped), false when the answer could not be read.
     */
    fun listArrived(dirPath: String, result: Any?): Boolean {
        val asked = askedListDirPath
        if (asked != null && asked != dirPath) return true

        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a sequence_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { parseSequence(array.optJSONObject(it)) }
        listCache[dirPath] = parsed
        // A lane the directory no longer names is a lane that is gone.
        val live = parsed.map { it.id }.toSet()
        detailCache.keys.removeAll(
            detailCache.filterValues { it.dirPath == dirPath && it.id !in live }.keys.toSet(),
        )
        _list.value = SequenceList.Ready(dirPath, parsed)
        return true
    }

    /** Record why the lanes are missing. The message is what the user reads. */
    fun listFailed(dirPath: String, message: String) {
        _list.value = SequenceList.Failed(dirPath, message)
    }

    /** An ask for one lane's detail. */
    fun detailRequested(sequenceId: String) {
        askedDetailSequenceId = sequenceId
        val cached = detailCache[sequenceId]
        _detail.value = if (cached != null) {
            SequenceDetail.Refreshing(sequenceId, cached)
        } else {
            SequenceDetail.Loading(sequenceId)
        }
    }

    /** Take a `sequence_get` result — one lane object. */
    fun detailArrived(sequenceId: String, result: Any?): Boolean {
        val asked = askedDetailSequenceId
        if (asked != null && asked != sequenceId) return true

        val sequence = parseSequence(result as? JSONObject) ?: run {
            WireShape.undecodable<Unit>("a sequence_get result", "a JSON object with an `id` string", result)
            return false
        }
        detailCache[sequenceId] = sequence
        _detail.value = SequenceDetail.Ready(sequence)
        return true
    }

    /** Record why the lane is missing. The message is what the user reads. */
    fun detailFailed(sequenceId: String, message: String) {
        _detail.value = SequenceDetail.Failed(sequenceId, message)
    }

    /**
     * A `sequence_delete` the desktop confirmed: purge now rather than show a
     * deleted lane until the refresh lands. Never called for a failed delete.
     */
    fun sequenceDeleted(sequenceId: String) {
        for (dirPath in listCache.keys.toList()) {
            listCache[dirPath] = listCache.getValue(dirPath).filter { it.id != sequenceId }
        }
        detailCache.remove(sequenceId)
        _list.value = when (val current = _list.value) {
            is SequenceList.Ready -> current.copy(sequences = current.sequences.filter { it.id != sequenceId })
            is SequenceList.Refreshing -> current.copy(cached = current.cached.filter { it.id != sequenceId })
            else -> current
        }
    }

    fun cleanupRequested(dirPath: String) {
        _cleanup.value = CleanupState.Loading(dirPath)
    }

    /** Take a `plan_cleanup_counts` result. False when it could not be read. */
    fun cleanupArrived(dirPath: String, result: Any?): Boolean {
        val json = result as? JSONObject ?: run {
            WireShape.undecodable<Unit>("a plan_cleanup_counts result", "a JSON object of counts", result)
            return false
        }
        fun count(key: String) = (json.opt(key) as? Number)?.toInt() ?: 0
        _cleanup.value = CleanupState.Ready(
            dirPath,
            CleanupCounts(
                donePlans = count("donePlans"),
                emptySequences = count("emptySequences"),
                unreferencedContexts = count("unreferencedContexts"),
                unusedContexts = count("unusedContexts"),
            ),
        )
        return true
    }

    fun cleanupFailed(dirPath: String, message: String) {
        _cleanup.value = CleanupState.Failed(dirPath, message)
    }

    /** One lane. A lane without an id is dropped rather than invented. */
    private fun parseSequence(entry: JSONObject?): HelmPlanSequence? {
        val id = entry?.opt("id") as? String ?: return null
        return HelmPlanSequence(
            id = id,
            projectId = entry.opt("projectId") as? String,
            dirPath = entry.opt("dirPath") as? String ?: "",
            title = entry.opt("title") as? String ?: id,
            missionStatement = entry.opt("missionStatement") as? String ?: "",
            sharedMemory = entry.opt("sharedMemory") as? String ?: "",
            // Order drives the board's lane order; an absent one sorts first,
            // which is what the desktop's own default (0) does.
            order = (entry.opt("order") as? Number)?.toInt() ?: 0,
            contextIds = strings(entry.opt("contextIds")),
            memberPlanIds = strings(entry.opt("memberPlanIds")),
            memberHumanIds = strings(entry.opt("memberHumanIds")),
            createdAtEpochMs = (entry.opt("createdAt") as? Number)?.toLong() ?: 0L,
            updatedAtEpochMs = (entry.opt("updatedAt") as? Number)?.toLong() ?: 0L,
        )
    }

    /** A string array read the wire-safe way: absent is empty, non-strings drop. */
    private fun strings(raw: Any?): List<String> {
        val array = raw as? JSONArray ?: return emptyList()
        return (0 until array.length()).mapNotNull { array.opt(it) as? String }
    }
}
