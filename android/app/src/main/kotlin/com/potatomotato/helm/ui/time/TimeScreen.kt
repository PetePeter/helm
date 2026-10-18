package com.potatomotato.helm.ui.time

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.TimeAnswer
import com.potatomotato.helm.data.TimeAsk
import com.potatomotato.helm.data.TimeChartModel
import com.potatomotato.helm.data.TimePeriod
import com.potatomotato.helm.data.TimeProjectTotal
import com.potatomotato.helm.data.TimeRow
import com.potatomotato.helm.data.TimeSheet
import com.potatomotato.helm.data.TimeTokenSheet
import com.potatomotato.helm.data.TimeTokenRow
import com.potatomotato.helm.data.TimeView
import com.potatomotato.helm.ui.artifacts.ContainedWebView
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Statistics surface — the user's time per project/folder or tokens per CLI
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
    BackHandler(enabled = ask.view == TimeView.Timesheet && ask.projectKey != null) { onAsk(ask.copy(projectKey = null, projectName = null)) }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Sm),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Toggle(stringResource(R.string.statistics_view_timesheet), selected = ask.view == TimeView.Timesheet) {
                onAsk(ask.copy(view = TimeView.Timesheet))
            }
            Toggle(stringResource(R.string.statistics_view_tokens), selected = ask.view == TimeView.Tokens) {
                onAsk(ask.copy(view = TimeView.Tokens))
            }
        }
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
        if (ask.view == TimeView.Timesheet && ask.projectKey != null) {
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
            loadingText = stringResource(if (ask.view == TimeView.Timesheet) R.string.time_loading else R.string.statistics_tokens_loading),
            emptyText = stringResource(if (ask.view == TimeView.Timesheet) R.string.time_empty else R.string.statistics_tokens_empty),
            isEmpty = { answer ->
                when (answer) {
                    is TimeAnswer.Projects -> answer.projects.isEmpty()
                    is TimeAnswer.Sheet -> answer.sheet.rows.isEmpty()
                    is TimeAnswer.Tokens -> answer.sheet.rows.isEmpty()
                }
            },
            onRefresh = { onFetch(ask) },
        ) { answer ->
            when (answer) {
                is TimeAnswer.Projects -> ProjectTotals(answer.projects, answer.chartModel) {
                    onAsk(ask.copy(projectKey = it.projectKey, projectName = it.projectName))
                }
                is TimeAnswer.Sheet -> FolderSheet(ask.period, answer.sheet, answer.chartModel)
                is TimeAnswer.Tokens -> TokenSheetView(ask.period, answer.sheet, answer.chartModel)
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
private fun ProjectTotals(
    projects: List<TimeProjectTotal>,
    chartModel: TimeChartModel?,
    onOpen: (TimeProjectTotal) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = HelmSpacing.Md)) {
        if (chartModel != null) {
            item { TimeChart(chartModel, stackedTokens = false) }
        }
        item { TableHeader(stringResource(R.string.time_col_project), includeTokens = true) }
        items(projects, key = { it.projectKey }) { project ->
            TableRow(project.projectName, project.userMinutes, project.aiMinutes, onClick = { onOpen(project) }, tokens = project.tokens)
        }
        item {
            TableRow(
                stringResource(R.string.time_total),
                projects.sumOf { it.userMinutes },
                projects.sumOf { it.aiMinutes },
                bold = true,
                tokens = projects.sumOf { it.tokens },
            )
        }
    }
}

@Composable
private fun FolderSheet(period: TimePeriod, sheet: TimeSheet, chartModel: TimeChartModel?) {
    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = HelmSpacing.Md)) {
        if (chartModel != null) {
            item { TimeChart(chartModel, stackedTokens = false) }
        }
        item { Folder(stringResource(R.string.time_total), TimeRow("", sheet.totalUser, sheet.totalAi, sheet.totalTokens), sheet.columns, period) }
        items(sheet.rows, key = { it.dir }) { row -> Folder(row.dir, row, sheet.columns, period) }
    }
}

@Composable
private fun TokenSheetView(period: TimePeriod, sheet: TimeTokenSheet, chartModel: TimeChartModel?) {
    val rows = visibleTokenRows(sheet)
    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = HelmSpacing.Md)) {
        if (chartModel != null) {
            item { TimeChart(chartModel, stackedTokens = true) }
        }
        item { TokenTable(period, sheet, rows, chartModel) }
    }
}

@Composable
private fun TimeChart(model: TimeChartModel, stackedTokens: Boolean) {
    val context = LocalContext.current
    val chartBundle = remember(context) {
        context.assets.open(CHART_ASSET).bufferedReader().use { it.readText() }
    }
    val theme = TimeChartTheme(
        text = HelmColors.Txt.toCssHex(),
        textMuted = HelmColors.Dim.toCssHex(),
        grid = HelmColors.Line.toCssHex(),
        tooltip = HelmColors.Surface2.toCssHex(),
        surface = HelmColors.Surface.toCssHex(),
    )
    val html = remember(model, chartBundle, theme, stackedTokens) {
        TimeChartDocument.build(model, chartBundle, theme, stackedTokens)
    }
    BoxWithConstraints(modifier = Modifier.fillMaxWidth().padding(vertical = HelmSpacing.Sm)) {
        ContainedWebView(
            html = html,
            modifier = Modifier.fillMaxWidth().height(chartHeightDp(maxWidth.value).dp),
        )
    }
}

internal fun chartHeightDp(widthDp: Float): Float =
    widthDp.coerceAtLeast(0f) * CHART_HEIGHT / CHART_WIDTH +
        CHART_LEGEND_ROW_HEIGHT +
        CHART_LEGEND_GAP

internal fun visibleTokenRows(sheet: TimeTokenSheet): List<TimeTokenRow> =
    sheet.rows.filter { it.tokens.sum() != 0L }

internal fun tokenChartSeriesColor(model: TimeChartModel?, cliType: String): String? =
    model?.series?.firstOrNull { it.key == "cli:$cliType" }?.color?.takeIf(HEX_CHART_COLOR::matches)

private fun Color.toCssHex(): String = String.format(Locale.ROOT, "#%06X", toArgb() and 0x00FFFFFF)

private fun parseChartColor(value: String): Color? {
    if (!HEX_CHART_COLOR.matches(value)) return null
    val rgb = value.substring(1).toLongOrNull(16) ?: return null
    return Color(
        red = ((rgb shr 16) and 0xFF).toFloat() / 255,
        green = ((rgb shr 8) and 0xFF).toFloat() / 255,
        blue = (rgb and 0xFF).toFloat() / 255,
    )
}

private const val CHART_WIDTH = 700f
private const val CHART_HEIGHT = 290f
private const val CHART_LEGEND_ROW_HEIGHT = 48f
private const val CHART_LEGEND_GAP = 8f
private const val CHART_ASSET = "chartjs/chart.umd.min.js"
private val HEX_CHART_COLOR = Regex("^#[0-9a-fA-F]{6}$")

private val TokenLabelColumn = 136.dp
private val TokenValueColumn = 76.dp

@Composable
private fun TokenTable(period: TimePeriod, sheet: TimeTokenSheet, rows: List<TimeTokenRow>, chartModel: TimeChartModel?) {
    val tableWidth = TokenLabelColumn + TokenValueColumn * (sheet.columns.size + 1)
    Column(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row(
            modifier = Modifier.width(tableWidth).padding(vertical = HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "CLI",
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.width(TokenLabelColumn),
                maxLines = 1,
            )
            sheet.columns.forEach { start ->
                Text(
                    text = columnLabel(period, start),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.labelMedium,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.width(TokenValueColumn),
                )
            }
            Text(
                text = stringResource(R.string.time_total),
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.End,
                maxLines = 1,
                modifier = Modifier.width(TokenValueColumn),
            )
        }
        HorizontalDivider(modifier = Modifier.width(tableWidth), color = HelmColors.Surface2)
        rows.forEachIndexed { index, row ->
            Row(
                modifier = Modifier.width(tableWidth).padding(vertical = HelmSpacing.Sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier.width(TokenLabelColumn).padding(end = HelmSpacing.Sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val seriesColor = tokenChartSeriesColor(chartModel, row.cliType)
                        ?.let(::parseChartColor)
                        ?: HelmColors.Statistics.Series[index % HelmColors.Statistics.Series.size]
                    Spacer(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(seriesColor),
                    )
                    Spacer(modifier = Modifier.width(HelmSpacing.Xs))
                    Text(
                        text = row.label,
                        color = HelmColors.Txt,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
                sheet.columns.indices.forEach { i ->
                    TokenNumber(row.tokens.getOrElse(i) { 0L })
                }
                TokenNumber(row.tokens.sum())
            }
        }
        HorizontalDivider(modifier = Modifier.width(tableWidth), color = HelmColors.Surface2)
        Row(
            modifier = Modifier.width(tableWidth).padding(vertical = HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.time_total),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                modifier = Modifier.width(TokenLabelColumn),
                maxLines = 1,
            )
            sheet.totals.forEach { TokenNumber(it, bold = true) }
            TokenNumber(sheet.totals.sum(), bold = true)
        }
    }
}

@Composable
private fun TokenNumber(value: Long, bold: Boolean = false) {
    Text(
        text = formatTokens(value),
        color = HelmColors.Txt,
        style = MaterialTheme.typography.bodyMedium.let { if (bold) it.copy(fontWeight = FontWeight.Bold) else it }
            .copy(fontFeatureSettings = "tnum"),
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier.width(TokenValueColumn),
    )
}

/** One folder: a table of only the columns that have time — a phone has no room for empty cells — then its total. */
@Composable
private fun Folder(title: String, row: TimeRow, columns: List<Long>, period: TimePeriod) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = HelmSpacing.Sm)) {
        Text(text = title, color = HelmColors.Txt, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        TableHeader(stringResource(R.string.time_col_when), includeTokens = true)
        columns.forEachIndexed { i, start ->
            val user = row.user.getOrElse(i) { 0 }
            val ai = row.ai.getOrElse(i) { 0 }
            val tokens = row.tokens.getOrElse(i) { 0 }
            if (user != 0 || ai != 0 || tokens != 0L) TableRow(columnLabel(period, start), user, ai, tokens = tokens)
        }
        TableRow(stringResource(R.string.time_total), row.user.sum(), row.ai.sum(), bold = true, tokens = row.tokens.sum())
    }
}

@Composable
private fun TableHeader(first: String, includeTokens: Boolean = false) {
    Cells(
        first,
        stringResource(R.string.time_col_you),
        stringResource(R.string.time_col_ai),
        stringResource(R.string.time_total),
        HelmColors.Dim,
        MaterialTheme.typography.labelMedium,
        tokens = if (includeTokens) stringResource(R.string.statistics_col_tokens) else null,
    )
    HorizontalDivider(color = HelmColors.Surface2)
}

@Composable
private fun TableRow(label: String, user: Int, ai: Int, bold: Boolean = false, onClick: (() -> Unit)? = null, tokens: Long? = null) {
    val style = MaterialTheme.typography.bodyMedium.let { if (bold) it.copy(fontWeight = FontWeight.Bold) else it }
    Cells(
        label, formatMinutes(user), formatMinutes(ai), formatMinutes(user + ai),
        color = HelmColors.Txt,
        style = style.copy(fontFeatureSettings = "tnum"),
        labelColor = if (onClick != null) HelmColors.Accent else HelmColors.Txt,
        modifier = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier,
        tokens = tokens?.let { if (it == 0L) "–" else formatTokens(it) },
    )
}

/** A label column that takes the slack, then three fixed right-aligned number columns. */
@Composable
private fun Cells(
    label: String, you: String, ai: String, total: String,
    color: Color, style: TextStyle,
    labelColor: Color = color,
    modifier: Modifier = Modifier,
    tokens: String? = null,
) {
    Row(modifier = modifier.fillMaxWidth().padding(vertical = HelmSpacing.Sm), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = labelColor, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        (listOf(you, ai, total) + listOfNotNull(tokens)).forEach {
            Text(it, color = color, style = style, textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(NumberColumn))
        }
    }
}

private val NumberColumn = 56.dp

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

private fun formatTokens(tokens: Long): String = when {
    tokens >= 1_000_000 -> compactTokens(tokens, 1_000_000, 2) + "M"
    tokens >= 1_000 -> compactTokens(tokens, 1_000, 1) + "k"
    else -> tokens.toString()
}

private fun compactTokens(tokens: Long, divisor: Long, scale: Int): String =
    BigDecimal.valueOf(tokens).divide(BigDecimal.valueOf(divisor), scale, RoundingMode.HALF_UP)
        .stripTrailingZeros().toPlainString()

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
