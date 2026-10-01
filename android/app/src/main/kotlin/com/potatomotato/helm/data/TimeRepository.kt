package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/**
 * The Time tab's views — the desktop's `periodEdges` names them on the wire.
 * [step] pages one view-width, on local calendar boundaries like the desktop.
 */
enum class TimePeriod(val wire: String) {
    Hour("hour"), Day("day"), Week("week"), Month("month");

    fun step(anchorEpochMs: Long, direction: Int): Long {
        val zone = ZoneId.systemDefault()
        val at = Instant.ofEpochMilli(anchorEpochMs).atZone(zone)
        val moved = when (this) {
            Hour -> at.plusDays(direction.toLong())
            Day -> at.plusWeeks(direction.toLong())
            Week -> at.plusMonths(direction.toLong())
            Month -> at.plusYears(direction.toLong())
        }
        return moved.toInstant().toEpochMilli()
    }
}

/**
 * One ask: a period around [anchorEpochMs]; every project's totals, or one
 * project's grid. [projectName] is only for the screen's header, never sent.
 */
data class TimeAsk(
    val period: TimePeriod,
    val anchorEpochMs: Long,
    val projectKey: String?,
    val projectName: String? = null,
)

data class TimeProjectTotal(val projectKey: String, val projectName: String, val userMinutes: Int, val aiMinutes: Int)

data class TimeRow(val dir: String, val user: List<Int>, val ai: List<Int>)

data class TimeSheet(val columns: List<Long>, val rows: List<TimeRow>, val totalUser: List<Int>, val totalAi: List<Int>)

sealed interface TimeAnswer {
    data class Projects(val projects: List<TimeProjectTotal>) : TimeAnswer
    data class Sheet(val sheet: TimeSheet) : TimeAnswer
}

/** The state of the Time tab, keyed by the ask that produced it. */
sealed interface TimeState {
    data object Idle : TimeState
    data class Loading(val ask: TimeAsk) : TimeState
    data class Refreshing(val ask: TimeAsk, val cached: TimeAnswer) : TimeState
    data class Ready(val ask: TimeAsk, val answer: TimeAnswer) : TimeState
    data class Failed(val ask: TimeAsk, val message: String) : TimeState
}

/**
 * TimeRepository — the phone's read of the user's own timesheet
 * (docs/time-tracking.md). Answered by the phone-only gate method
 * `__timesheet__`; no AI tool reads this data.
 *
 * Keyed by the whole ask, like the other repositories key by scope: a late
 * answer for a period or project the user already paged away from is dropped.
 */
class TimeRepository {
    private val _state = MutableStateFlow<TimeState>(TimeState.Idle)
    val state: StateFlow<TimeState> = _state.asStateFlow()

    private val cache = HashMap<TimeAsk, TimeAnswer>()
    private var asked: TimeAsk? = null

    fun requested(ask: TimeAsk) {
        asked = ask
        val cached = cache[ask]
        _state.value = if (cached != null) TimeState.Refreshing(ask, cached) else TimeState.Loading(ask)
    }

    /** True when settled (applied, or a stale arrival dropped); false when unreadable. */
    fun arrived(ask: TimeAsk, result: Any?): Boolean {
        if (asked != null && asked != ask) return true
        val answer = parse(result as? JSONObject) ?: run {
            WireShape.undecodable<Unit>("a __timesheet__ result", "an object with `projects` or `sheet`", result)
            return false
        }
        cache[ask] = answer
        _state.value = TimeState.Ready(ask, answer)
        return true
    }

    fun failed(ask: TimeAsk, message: String) {
        if (asked == ask) _state.value = TimeState.Failed(ask, message)
    }

    private fun parse(json: JSONObject?): TimeAnswer? {
        if (json == null) return null
        json.optJSONArray("projects")?.let { array ->
            return TimeAnswer.Projects(
                (0 until array.length()).mapNotNull { i ->
                    val o = array.optJSONObject(i) ?: return@mapNotNull null
                    val key = o.opt("projectKey") as? String ?: return@mapNotNull null
                    TimeProjectTotal(key, o.opt("projectName") as? String ?: key, o.optInt("user"), o.optInt("ai"))
                },
            )
        }
        val sheet = json.optJSONObject("sheet") ?: return null
        val columns = sheet.optJSONArray("columns") ?: return null
        val totals = sheet.optJSONObject("totals")
        return TimeAnswer.Sheet(
            TimeSheet(
                columns = (0 until columns.length()).map { columns.optLong(it) },
                rows = sheet.optJSONArray("rows")?.let { rows ->
                    (0 until rows.length()).mapNotNull { i ->
                        val o = rows.optJSONObject(i) ?: return@mapNotNull null
                        val dir = o.opt("dir") as? String ?: return@mapNotNull null
                        TimeRow(dir, ints(o.optJSONArray("user")), ints(o.optJSONArray("ai")))
                    }
                }.orEmpty(),
                totalUser = ints(totals?.optJSONArray("user")),
                totalAi = ints(totals?.optJSONArray("ai")),
            ),
        )
    }

    private fun ints(array: JSONArray?): List<Int> =
        if (array == null) emptyList() else (0 until array.length()).map { array.optInt(it) }
}
