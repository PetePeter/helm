package com.potatomotato.helm.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.StateDot
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Mockup screen 1 — every session Helm is running, grouped by project.
 *
 * The list is keyed on session id so a poll that changes one dot recomposes one
 * row; [com.potatomotato.helm.data.SessionRepository] does the merging that
 * makes that true. Ordering is decided there too, never here.
 */
@Composable
fun SessionListScreen(
    sessions: List<HelmSession>,
    linkState: LinkState,
    onOpen: (HelmSession) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(title = stringResource(R.string.app_name), linkState = linkState)

        if (sessions.isEmpty()) {
            EmptyList(linkState)
            return@Column
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            // Sessions arrive already ordered by project, so a header goes in
            // wherever the project changes — no second grouping pass, and no
            // second opinion about the order.
            sessions.forEachIndexed { index, session ->
                if (index == 0 || sessions[index - 1].projectLabel != session.projectLabel) {
                    item(key = "header:${session.projectLabel}") { ProjectHeader(session.projectLabel) }
                }
                item(key = session.id) { SessionRow(session, onClick = { onOpen(session) }) }
            }
        }
    }
}

@Composable
private fun ProjectHeader(label: String) {
    Text(
        text = label.uppercase(),
        color = HelmColors.Faint,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = HelmSpacing.Gutter, end = HelmSpacing.Gutter, top = HelmSpacing.Lg, bottom = HelmSpacing.Sm),
    )
}

@Composable
private fun SessionRow(session: HelmSession, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HelmSize.TouchTarget)
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        StateDot(state = session.activity)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = session.name,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                // Truncate, never wrap: a two-line row breaks the rhythm of the
                // list far more than a clipped name costs.
                overflow = TextOverflow.Ellipsis,
            )
            if (session.cliTypeName.isNotEmpty()) {
                Text(
                    text = session.cliTypeName,
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * Nothing to show is two different situations, and conflating them is how a user
 * ends up waiting on a list that was never coming.
 */
@Composable
private fun EmptyList(linkState: LinkState) {
    val message = if (linkState == LinkState.Linked) R.string.sessions_none else R.string.sessions_no_link

    Box(
        modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(message),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
    }
}
