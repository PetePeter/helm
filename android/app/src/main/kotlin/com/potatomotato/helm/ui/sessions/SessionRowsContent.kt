package com.potatomotato.helm.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.rememberEtaNow
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/** One grouped row renderer for the session list and tablet session picker. */
@Composable
internal fun SessionRowsContent(
    sessions: List<HelmSession>,
    unread: Map<String, Int>,
    contextHistories: Map<String, ContextHistory>,
    collapsedGroups: Set<String>,
    selectedId: String?,
    onToggleGroup: (String) -> Unit,
    onOpen: (HelmSession) -> Unit,
    onLongPress: (HelmSession) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val rows = remember(sessions, collapsedGroups) { SessionRows.build(sessions, collapsedGroups) }
    val etas = remember(rows) { rows.mapNotNull { (it as? RowEntry.Session)?.session?.eta } }
    val nowMs = rememberEtaNow(etas)
    val listState = rememberLazyListState()
    LaunchedEffect(selectedId, rows) {
        rows.indexOfFirst { it is RowEntry.Session && it.session.id == selectedId }
            .takeIf { it >= 0 }
            ?.let { listState.animateScrollToItem(it) }
    }

    LazyColumn(state = listState, modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        for (entry in rows) {
            when (entry) {
                is RowEntry.Header -> item(key = "header:${entry.label}") {
                    ProjectHeader(entry.label, entry.collapsed, entry.count) { onToggleGroup(entry.label) }
                }

                is RowEntry.Session -> item(key = entry.session.id) {
                    SessionRow(
                        session = entry.session,
                        unreadCount = unread[entry.session.id] ?: 0,
                        context = if (compact) null else contextHistories[entry.session.id],
                        nowMs = nowMs,
                        selected = entry.session.id == selectedId,
                        compact = compact,
                        onClick = { onOpen(entry.session) },
                        onLongClick = { onLongPress(entry.session) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ProjectHeader(label: String, collapsed: Boolean, count: Int, onToggle: () -> Unit) {
    Column {
        Hairline(color = HelmColors.Separator)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .clickable(onClick = onToggle)
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
        ) {
            Text(
                text = label.uppercase(),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (collapsed) {
                Text(
                    text = pluralStringResource(R.plurals.sessions_group_count, count, count),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Text(
                text = stringResource(if (collapsed) R.string.group_collapsed_glyph else R.string.group_expanded_glyph),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}
