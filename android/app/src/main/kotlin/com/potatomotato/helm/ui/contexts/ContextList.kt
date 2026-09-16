package com.potatomotato.helm.ui.contexts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.ui.components.CHEVRON
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.Pill
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * One project's context nodes.
 *
 * Scope-blind like the plan and lane lists: it never sees a projectId, only the
 * resolved answer for one.
 *
 * `context_list` already carries every node's body, but the row does NOT show
 * it: a project's context is prose measured in paragraphs, and a list of
 * paragraph fragments is harder to scan than a list of titles. The row carries
 * the two facts that distinguish nodes at a glance — the type and whether an
 * agent may rewrite it — and the body is the detail screen's job. That screen
 * re-reads the node anyway, because between the list and the tap it may have
 * been rewritten.
 */
@Composable
fun ContextList(
    contexts: LoadView<List<HelmContext>>,
    onOpen: (HelmContext) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LoadBody(
        view = contexts,
        loadingText = stringResource(R.string.contexts_loading),
        emptyText = stringResource(R.string.contexts_empty),
        isEmpty = { it.isEmpty() },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { nodes ->
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(nodes, key = { it.id }) { node ->
                ContextRow(node, onClick = { onOpen(node) })
            }
        }
    }
}

@Composable
private fun ContextRow(context: HelmContext, onClick: () -> Unit) {
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .clickable(onClick = onClick)
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = context.title,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = context.type.ifBlank { stringResource(R.string.context_type_none) },
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Pill(text = stringResource(context.permission.labelRes), color = context.permission.pillColor)
            Text(
                text = CHEVRON,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.titleLarge,
            )
        }
        Hairline(color = HelmColors.Separator)
    }
}
