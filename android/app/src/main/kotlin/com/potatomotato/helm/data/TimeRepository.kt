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
 * The Statistics screen's views — the desktop's `periodEdges` names them on the wire.
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

enum class TimeView(val wire: String) { Timesheet("timesheet"), Tokens("tokens") }

/**
 * One ask: a view and period around [anchorEpochMs]; every project's totals,
 * one project's grid, or CLI token rows. [projectName] is display-only.
 */
data class TimeAsk(
    val period: TimePeriod,
    val anchorEpochMs: Long,
    val projectKey: String?,
    val projectName: String? = null,
    val view: TimeView = TimeView.Timesheet,
)

data class TimeProjectTotal(val projectKey: String, val projectName: String, val userMinutes: Int, val aiMinutes: Int, val tokens: Long = 0)

data class TimeRow(val dir: String, val user: List<Int>, val ai: List<Int>, val tokens: List<Long> = emptyList())

data class TimeSheet(
    val columns: List<Long>,
    val rows: List<TimeRow>,
    val totalUser: List<Int>,
    val totalAi: List<Int>,
    val totalTokens: List<Long> = emptyList(),
)

data class TimeTokenRow(val cliType: String, val label: String, val tokens: List<Long>)

data class TimeTokenSheet(val columns: List<Long>, val rows: List<TimeTokenRow>, val totals: List<Long>)

enum class TimeChartSeriesType(val wire: String) {
    BAR("bar"), LINE("line");

    companion object {
        fun fromWire(wire: String): TimeChartSeriesType? = entries.firstOrNull { it.wire == wire }
    }
}

enum class TimeChartAxisKind(val wire: String) {
    MINUTES("minutes"), TOKENS("tokens");

    companion object {
        fun fromWire(wire: String): TimeChartAxisKind? = entries.firstOrNull { it.wire == wire }
    }
}

data class TimeChartSeries(
    val key: String,
    val label: String,
    val color: String,
    val type: TimeChartSeriesType,
    val axis: TimeChartAxisKind,
    val values: List<Long>,
)

data class TimeChartModel(val columns: List<Long>, val labels: List<String>, val series: List<TimeChartSeries>)

/** Chart data is null when connected to an older desktop that does not send it. */
sealed interface TimeAnswer {
    val chartModel: TimeChartModel?

    data class Projects(
        val projects: List<TimeProjectTotal>,
        override val chartModel: TimeChartModel? = null,
    ) : TimeAnswer
    data class Sheet(
        val sheet: TimeSheet,
        override val chartModel: TimeChartModel? = null,
    ) : TimeAnswer
    data class Tokens(
        val sheet: TimeTokenSheet,
        override val chartModel: TimeChartModel? = null,
    ) : TimeAnswer
}

/** The state of the Statistics screen, keyed by the ask that produced it. */
sealed interface TimeState {
    data object Idle : TimeState
    data class Loading(val ask: TimeAsk) : TimeState
    data class Refreshing(val ask: TimeAsk, val cached: TimeAnswer) : TimeState
    data class Ready(val ask: TimeAsk, val answer: TimeAnswer) : TimeState
    data class Failed(val ask: TimeAsk, val message: String) : TimeState
}

/**
 * TimeRepository — the phone's read of the user's own time and token statistics
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
        val answer = parse(result as? JSONObject, ask.view) ?: run {
            val expected = if (ask.view == TimeView.Tokens) "a token sheet with `columns`, `rows`, and `totals`" else "an object with `projects` or `sheet`"
            WireShape.undecodable<Unit>("a __timesheet__ result", expected, result)
            return false
        }
        cache[ask] = answer
        _state.value = TimeState.Ready(ask, answer)
        return true
    }

    fun failed(ask: TimeAsk, message: String) {
        if (asked == ask) _state.value = TimeState.Failed(ask, message)
    }

    private fun parse(json: JSONObject?, view: TimeView): TimeAnswer? {
        if (json == null) return null
        val chartModel = parseChartModel(json.optJSONObject("chartModel"))
        if (view == TimeView.Tokens) {
            val sheet = json.optJSONObject("sheet") ?: return null
            val columns = sheet.optJSONArray("columns") ?: return null
            val rows = sheet.optJSONArray("rows") ?: return null
            val totals = sheet.optJSONArray("totals") ?: return null
            return TimeAnswer.Tokens(
                sheet = TimeTokenSheet(
                    columns = (0 until columns.length()).map { columns.optLong(it) },
                    rows = (0 until rows.length()).mapNotNull { i ->
                        val row = rows.optJSONObject(i) ?: return@mapNotNull null
                        val cliType = row.opt("cliType") as? String ?: return@mapNotNull null
                        val label = row.opt("label") as? String ?: return@mapNotNull null
                        TimeTokenRow(cliType, label, longs(row.optJSONArray("tokens")))
                    },
                    totals = longs(totals),
                ),
                chartModel = chartModel,
            )
        }
        json.optJSONArray("projects")?.let { array ->
            return TimeAnswer.Projects(
                projects = (0 until array.length()).mapNotNull { i ->
                    val o = array.optJSONObject(i) ?: return@mapNotNull null
                    val key = o.opt("projectKey") as? String ?: return@mapNotNull null
                    TimeProjectTotal(key, o.opt("projectName") as? String ?: key, o.optInt("user"), o.optInt("ai"), o.optLong("tokens"))
                },
                chartModel = chartModel,
            )
        }
        val sheet = json.optJSONObject("sheet") ?: return null
        val columns = sheet.optJSONArray("columns") ?: return null
        val totals = sheet.optJSONObject("totals")
        return TimeAnswer.Sheet(
            sheet = TimeSheet(
                columns = (0 until columns.length()).map { columns.optLong(it) },
                rows = sheet.optJSONArray("rows")?.let { rows ->
                    (0 until rows.length()).mapNotNull { i ->
                        val o = rows.optJSONObject(i) ?: return@mapNotNull null
                        val dir = o.opt("dir") as? String ?: return@mapNotNull null
                        TimeRow(dir, ints(o.optJSONArray("user")), ints(o.optJSONArray("ai")), longs(o.optJSONArray("tokens")))
                    }
                }.orEmpty(),
                totalUser = ints(totals?.optJSONArray("user")),
                totalAi = ints(totals?.optJSONArray("ai")),
                totalTokens = longs(totals?.optJSONArray("tokens")),
            ),
            chartModel = chartModel,
        )
    }

    private fun parseChartModel(json: JSONObject?): TimeChartModel? {
        if (json == null) return null
        val columns = json.optJSONArray("columns") ?: return null
        val labels = json.optJSONArray("labels") ?: return null
        val series = json.optJSONArray("series") ?: return null
        if (columns.length() != labels.length()) return null
        val parsedSeries = (0 until series.length()).map { i ->
            val item = series.optJSONObject(i) ?: return null
            val key = item.opt("key") as? String ?: return null
            val label = item.opt("label") as? String ?: return null
            val color = item.opt("color") as? String ?: return null
            val type = TimeChartSeriesType.fromWire(item.opt("type") as? String ?: return null) ?: return null
            val axis = TimeChartAxisKind.fromWire(item.opt("axis") as? String ?: return null) ?: return null
            val values = item.optJSONArray("values") ?: return null
            if (values.length() != columns.length()) return null
            TimeChartSeries(key, label, color, type, axis, longs(values))
        }
        val parsedLabels = (0 until labels.length()).map { labels.opt(it) as? String ?: return null }
        return TimeChartModel(
            columns = (0 until columns.length()).map { columns.optLong(it) },
            labels = parsedLabels,
            series = parsedSeries,
        )
    }

    private fun ints(array: JSONArray?): List<Int> =
        if (array == null) emptyList() else (0 until array.length()).map { array.optInt(it) }

    private fun longs(array: JSONArray?): List<Long> =
        if (array == null) emptyList() else (0 until array.length()).map { array.optLong(it) }
}
