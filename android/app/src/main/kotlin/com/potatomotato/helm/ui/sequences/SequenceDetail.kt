package com.potatomotato.helm.ui.sequences

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.components.GlyphButton
import com.potatomotato.helm.ui.plans.PlanWriteLine
import com.potatomotato.helm.ui.plans.SequenceFormDialog
import com.potatomotato.helm.ui.components.DetailFieldBlock
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * One sequence lane, in full: what it is for, what it remembers, and which plans
 * are in it.
 *
 * Scope-blind like every other surface here — it is handed a resolved lane.
 *
 * The member list is TEXT, not tappable rows. A lane's plans are already
 * tappable on the board one screen away; making them a second navigation path
 * would mean two routes into the plan detail whose back behaviour must then
 * differ, for no reading the board does not already give.
 */
@Composable
fun SequenceDetail(
    sequence: LoadView<HelmPlanSequence>,
    onRefresh: () -> Unit,
    write: PlanWrite,
    onDismissWrite: () -> Unit,
    onEdit: (title: String, mission: String) -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var editing by rememberSaveable { mutableStateOf(false) }
    var deleting by rememberSaveable { mutableStateOf(false) }
    val shown = (sequence as? LoadView.Ready)?.data
    Box(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            PlanWriteLine(write, onDismissWrite)
            if (shown != null) {
                // Edit and delete sit above the body so they are reachable
                // without scrolling past a long mission or member list.
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter),
                    horizontalArrangement = Arrangement.End,
                ) {
                    GlyphButton(
                        glyph = stringResource(R.string.control_glyph_rename),
                        description = stringResource(R.string.sequence_edit_title),
                        onClick = { editing = true },
                    )
                    GlyphButton(
                        glyph = stringResource(R.string.artifacts_glyph_delete),
                        description = stringResource(R.string.sequence_delete_action),
                        onClick = { deleting = true },
                    )
                }
            }
            SequenceBody(sequence, onRefresh, Modifier.weight(1f))
        }
        if (shown != null && editing) {
            SequenceFormDialog(
                heading = stringResource(R.string.sequence_edit_title),
                initialTitle = shown.title,
                initialMission = shown.missionStatement,
                onSave = { title, mission -> editing = false; onEdit(title, mission) },
                onCancel = { editing = false },
            )
        }
        if (shown != null && deleting) {
            ConfirmDelete(
                // Deleting a lane does not delete its plans — they fall back to
                // ungrouped — and the confirm says so, because that is the
                // question a user actually has before tapping.
                message = stringResource(R.string.sequence_confirm_delete, shown.title),
                onConfirm = { deleting = false; onDelete() },
                onCancel = { deleting = false },
            )
        }
    }
}

@Composable
private fun SequenceBody(sequence: LoadView<HelmPlanSequence>, onRefresh: () -> Unit, modifier: Modifier) {
    LoadBody(
        view = sequence,
        loadingText = stringResource(R.string.sequence_detail_loading),
        emptyText = stringResource(R.string.sequence_detail_loading),
        // A lane that arrived always has a title; the empty branch is unreachable.
        isEmpty = { false },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { shown ->
        val fields = SequenceFields.of(shown)
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            item(key = "head") {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
                ) {
                    Text(
                        text = shown.title,
                        color = HelmColors.Txt,
                        style = MaterialTheme.typography.titleLarge,
                    )
                }
            }
            items(fields.size) { index -> DetailFieldBlock(fields[index]) }
        }
    }
}
