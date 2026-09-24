package com.potatomotato.helm.ui.sequences

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.CleanupState
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.plans.PlanWriteLine
import com.potatomotato.helm.ui.plans.SequenceFormDialog
import com.potatomotato.helm.ui.components.CHEVRON
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.plans.PlanGrouping
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The sequence lanes of ONE scope, as a list of their own.
 *
 * Scope-blind exactly like the plan board: it takes a resolved [LoadView] and
 * nothing else, so the in-session Sequences tab and any future top-level lane
 * view render the same rows.
 *
 * The lanes keep the board's ORDER by calling the board's own comparator —
 * [PlanGrouping.laneOrder] — rather than restating it. Two surfaces disagreeing
 * about which lane comes first would be the same data read two ways, and that is
 * better prevented than promised.
 */
@Composable
fun SequenceList(
    sequences: LoadView<List<HelmPlanSequence>>,
    onOpen: (HelmPlanSequence) -> Unit,
    onRefresh: () -> Unit,
    cleanup: CleanupState,
    write: PlanWrite,
    onDismissWrite: () -> Unit,
    onCreate: (title: String, mission: String) -> Unit,
    onClearUnused: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var creating by rememberSaveable { mutableStateOf(false) }
    var confirmingClear by rememberSaveable { mutableStateOf(false) }
    val counts = (cleanup as? CleanupState.Ready)?.counts
    Box(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            GhostButton(
                text = stringResource(R.string.sequence_new_action),
                onClick = { creating = true },
                modifier = Modifier.padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            )
            CleanupRow(cleanup, onClear = { confirmingClear = true })
            PlanWriteLine(write, onDismissWrite)
            SequenceRows(sequences, onOpen, onRefresh, Modifier.weight(1f))
        }
        if (creating) {
            SequenceFormDialog(
                heading = stringResource(R.string.sequence_new_title),
                initialTitle = "",
                initialMission = "",
                onSave = { title, mission -> creating = false; onCreate(title, mission) },
                onCancel = { creating = false },
            )
        }
        if (confirmingClear && counts != null) {
            ConfirmDelete(
                message = stringResource(R.string.sequence_clear_confirm, counts.emptySequences, counts.unusedContexts),
                confirmText = stringResource(R.string.sequence_clear_action),
                onConfirm = { confirmingClear = false; onClearUnused() },
                onCancel = { confirmingClear = false },
            )
        }
    }
}

/**
 * What "Clear unused" would remove, said BEFORE it is offered — the desktop's
 * cleanup counts, so the phone deletes exactly what the desktop dialog would.
 * The action greys at zero rather than asking to delete nothing.
 */
@Composable
private fun CleanupRow(cleanup: CleanupState, onClear: () -> Unit) {
    val (text, color) = when (cleanup) {
        CleanupState.Idle, is CleanupState.Loading -> stringResource(R.string.sequence_cleanup_loading) to HelmColors.Faint
        is CleanupState.Failed -> cleanup.message to HelmColors.Danger
        is CleanupState.Ready -> stringResource(
            R.string.sequence_cleanup_counts,
            cleanup.counts.emptySequences,
            cleanup.counts.unusedContexts,
        ) to HelmColors.Dim
    }
    val canClear = cleanup is CleanupState.Ready && !cleanup.counts.nothingToClear
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HelmSize.TouchTarget)
            .padding(horizontal = HelmSpacing.Gutter),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        Text(text = text, color = color, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        Text(
            text = stringResource(R.string.sequence_clear_action),
            color = if (canClear) HelmColors.Danger else HelmColors.Faint,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .clickable(enabled = canClear, onClick = onClear)
                .padding(HelmSpacing.Sm),
        )
    }
}

@Composable
private fun SequenceRows(
    sequences: LoadView<List<HelmPlanSequence>>,
    onOpen: (HelmPlanSequence) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier,
) {
    LoadBody(
        view = sequences,
        loadingText = stringResource(R.string.sequences_loading),
        emptyText = stringResource(R.string.sequences_empty),
        isEmpty = { it.isEmpty() },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { lanes ->
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(lanes.sortedWith(PlanGrouping.laneOrder()), key = { it.id }) { lane ->
                SequenceRow(lane, onClick = { onOpen(lane) })
            }
        }
    }
}

@Composable
private fun SequenceRow(sequence: HelmPlanSequence, onClick: () -> Unit) {
    val members = SequenceFields.memberIds(sequence)
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
                    text = sequence.title,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = pluralStringResource(R.plurals.sequences_member_count, members.size, members.size),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                text = CHEVRON,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.titleLarge,
            )
        }
        Hairline(color = HelmColors.Separator)
    }
}
