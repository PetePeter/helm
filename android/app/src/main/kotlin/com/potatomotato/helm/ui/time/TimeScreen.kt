package com.potatomotato.helm.ui.time

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.TimeAnswer
import com.potatomotato.helm.data.TimeAsk
import com.potatomotato.helm.data.TimePeriod
import com.potatomotato.helm.data.TimeProjectTotal
import com.potatomotato.helm.data.TimeRow
import com.potatomotato.helm.data.TimeSheet
import com.potatomotato.helm.ui.components.HelmRow
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The Time tab — the user's own time per project, then per folder
 * (docs/time-tracking.md). The ask (view, page, project) lives with the
 * caller so it survives leaving the tab; this screen only draws an answer and
 * reports what the user picked. Fetched on arrival and on every change of ask.
 */
@Composable
fun TimeScreen(
    ask: TimeAsk,
    view: LoadView<TimeAnswer>,
    onAsk: (TimeAsk) -> Unit,
    onFetch: (TimeAsk) -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(ask) { onFetch(ask) }
    BackHandler(enabled = ask.projectKey != null) { onAsk(ask.copy(projectKey = null, projectName = null)) }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Sm),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TimePeriod.entries.forEach { period ->
                Toggle(stringResource(period.labelRes), selected = period == ask.period) { onAsk(ask.copy(period = period)) }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Sm),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Toggle("◀", selected = false) { onAsk(ask.copy(anchorEpochMs = ask.period.step(ask.anchorEpochMs, -1))) }
            Toggle(rangeLabel(ask), selected = false) { onAsk(ask.copy(anchorEpochMs = System.currentTimeMillis())) }
            Toggle("▶", selected = false) { onAsk(ask.copy(anchorEpochMs = ask.period.step(ask.anchorEpochMs, 1))) }
        }
        if (ask.projectKey != null) {
            Text(
                text = "‹ " + (ask.projectName ?: ask.projectKey),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onAsk(ask.copy(projectKey = null, projectName = null)) }
                    .padding(HelmSpacing.Md),
            )
        }
        LoadBody(
            view = view,
            loadingText = stringResource(R.string.time_loading),
            emptyText = stringResource(R.string.time_empty),
            isEmpty = { answer ->
                when (answer) {
                    is TimeAnswer.Projects -> answer.projects.isEmpty()
                    is TimeAnswer.Sheet -> answer.sheet.rows.isEmpty()
                }
            },
            onRefresh = { onFetch(ask) },
        ) { answer ->
            when (answer) {
                is TimeAnswer.Projects -> ProjectTotals(answer.projects) { onAsk(ask.copy(projectKey = it.projectKey, projectName = it.projectName)) }
                is TimeAnswer.Sheet -> FolderSheet(ask.period, answer.sheet)
            }
        }
    }
}

@Composable
private fun Toggle(text: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        color = if (selected) HelmColors.OnAccent else HelmColors.Txt,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(if (selected) HelmColors.Accent else HelmColors.Surface2)
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    )
}

@Composable
private fun ProjectTotals(projects: List<TimeProjectTotal>, onOpen: (TimeProjectTotal) -> Unit) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(projects, key = { it.projectKey }) { project ->
            HelmRow(
                title = project.projectName,
                onClick = { onOpen(project) },
                subtitle = { Minutes(project.userMinutes, project.aiMinutes) },
            )
        }
    }
}

@Composable
private fun FolderSheet(period: TimePeriod, sheet: TimeSheet) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item { Folder(stringResource(R.string.time_total), TimeRow("", sheet.totalUser, sheet.totalAi), sheet.columns, period) }
        items(sheet.rows, key = { it.dir }) { row -> Folder(row.dir, row, sheet.columns, period) }
    }
}

/** One folder: its total, then only the columns that have time — a phone has no room for empty cells. */
@Composable
private fun Folder(title: String, row: TimeRow, columns: List<Long>, period: TimePeriod) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm)) {
        Text(text = title, color = HelmColors.Txt, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Minutes(row.user.sum(), row.ai.sum())
        columns.forEachIndexed { i, start ->
            val user = row.user.getOrElse(i) { 0 }
            val ai = row.ai.getOrElse(i) { 0 }
            if (user == 0 && ai == 0) return@forEachIndexed
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(text = columnLabel(period, start), color = HelmColors.Dim, style = MaterialTheme.typography.bodySmall)
                Minutes(user, ai)
            }
        }
    }
}

@Composable
private fun Minutes(user: Int, ai: Int) {
    Text(
        text = stringResource(R.string.time_you_ai, formatMinutes(user), formatMinutes(ai)),
        color = HelmColors.Dim,
        style = MaterialTheme.typography.bodySmall,
    )
}

private val TimePeriod.labelRes: Int
    get() = when (this) {
        TimePeriod.Hour -> R.string.time_period_hour
        TimePeriod.Day -> R.string.time_period_day
        TimePeriod.Week -> R.string.time_period_week
        TimePeriod.Month -> R.string.time_period_month
    }

/** Minutes as "3h05"; zero as an en dash, like the desktop pane. */
internal fun formatMinutes(minutes: Int): String =
    if (minutes == 0) "–" else "${minutes / 60}h${(minutes % 60).toString().padStart(2, '0')}"

private fun columnLabel(period: TimePeriod, startEpochMs: Long): String {
    val at = Instant.ofEpochMilli(startEpochMs).atZone(ZoneId.systemDefault())
    val pattern = when (period) {
        TimePeriod.Hour -> "HH:00"
        TimePeriod.Day -> "EEE d"
        TimePeriod.Week -> "'w/c' d MMM"
        TimePeriod.Month -> "MMMM"
    }
    return at.format(DateTimeFormatter.ofPattern(pattern))
}

private fun rangeLabel(ask: TimeAsk): String {
    val at = Instant.ofEpochMilli(ask.anchorEpochMs).atZone(ZoneId.systemDefault())
    val pattern = when (ask.period) {
        TimePeriod.Hour -> "EEE d MMM"
        TimePeriod.Day -> "'week of' d MMM"
        TimePeriod.Week -> "MMMM yyyy"
        TimePeriod.Month -> "yyyy"
    }
    return at.format(DateTimeFormatter.ofPattern(pattern))
}
