package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.ContextRingButton
import com.potatomotato.helm.ui.rememberEtaNow
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

internal const val TABLET_SELECT_SESSION = "Select a session"

@Composable
internal fun TabletSessionHeader(
    session: HelmSession?,
    sessions: List<HelmSession>,
    unread: Map<String, Int>,
    contextHistories: Map<String, ContextHistory>,
    collapsed: Boolean,
    shell: TabletShellState,
    onTogglePicker: () -> Unit,
    onPickSession: (String) -> Unit,
    onOpenTodos: () -> Unit,
    actionBar: (@Composable () -> Unit)? = null,
) {
    val nowMs = rememberEtaNow(listOfNotNull(session?.eta))
    Box(modifier = Modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            if (session != null) {
                ContextRingButton(
                    state = session.activity,
                    history = contextHistories[session.id],
                    quotaUsage = session.quotaUsage,
                )
            }
            Column(
                modifier = Modifier.weight(1f).clickable(enabled = collapsed, onClick = onTogglePicker),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs)) {
                    Text(
                        text = session?.let {
                            listOf(it.name, it.statusIcons(nowMs)).filter(String::isNotEmpty).joinToString("  ")
                        } ?: TABLET_SELECT_SESSION,
                        color = HelmColors.Txt,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (collapsed) Text("⌄", color = HelmColors.Dim, style = MaterialTheme.typography.titleMedium)
                }
                session?.let {
                    Text(
                        text = com.potatomotato.helm.ui.sessionHeaderDetails(it, nowMs),
                        color = HelmColors.Dim,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            actionBar?.invoke()
            if (session != null) {
                Box(
                    modifier = Modifier
                        .clickable(enabled = collapsed, onClick = onOpenTodos)
                        .heightIn(min = HelmSize.TouchTarget)
                        .padding(horizontal = HelmSpacing.Sm),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = shell.todoTitle(session.todos.size),
                        color = HelmColors.Accent,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                    )
                }
            }
        }
        if (collapsed) {
            SessionPickerDropdown(
                expanded = shell.pickerOpen,
                sessions = sessions,
                unread = unread,
                contextHistories = contextHistories,
                selectedId = session?.id,
                onSelect = onPickSession,
                onDismiss = onTogglePicker,
            )
        }
    }
}
