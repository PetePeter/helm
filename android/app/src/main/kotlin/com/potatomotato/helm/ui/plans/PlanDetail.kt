package com.potatomotato.helm.ui.plans

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.data.HelmPlanContextRef
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.components.GlyphButton
import com.potatomotato.helm.ui.components.DetailFieldBlock
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.Pill
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * One plan, in full — and the context it actually runs with.
 *
 * Scope-blind like [PlanList]: it is handed the plan and the refs, never a
 * dirPath or a session, so both surfaces open the same screen.
 *
 * THE REFS ARE A SECOND ASK and therefore a second [LoadView]. `plan_get` does
 * not carry them: the effective context is the plan's own bindings merged with
 * its sequence's, which the desktop computes behind `plan_context_list`. They
 * land on their own schedule and get their own section, so a plan that is
 * readable does not wait on refs that are not.
 *
 * NO CONTENT, ONLY REFS. A ref names a context node and says where the binding
 * came from; the body is a `context_get` away and is read on the context screen.
 * That is the desktop's split, and duplicating the body here would mean two
 * places to keep in step.
 */
@Composable
fun PlanDetail(
    plan: LoadView<HelmPlan>,
    contexts: LoadView<List<HelmPlanContextRef>>,
    onRefresh: () -> Unit,
    actions: PlanDetailActions,
    modifier: Modifier = Modifier,
) {
    var dialog by rememberSaveable { mutableStateOf<PlanDialog?>(null) }
    val shownPlan = (plan as? LoadView.Ready)?.data
    Box(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            PlanWriteLine(actions.write, actions.onDismissWrite)
            PlanBody(plan, contexts, onRefresh, actions, onDialog = { dialog = it }, modifier = Modifier.weight(1f))
        }
        if (shownPlan != null) {
            PlanDialogs(dialog, shownPlan, actions, close = { dialog = null })
        }
    }
}

/**
 * Everything the detail screen can WRITE (P-0812), handed in as one bundle so
 * the screen stays scope-blind: the caller knows the directory and the client,
 * this file knows only which button was pressed.
 */
class PlanDetailActions(
    val lanes: List<HelmPlanSequence>,
    val write: PlanWrite,
    val onDismissWrite: () -> Unit,
    val onEdit: (title: String, description: String) -> Unit,
    val onSetState: (PlanStatus) -> Unit,
    val onComplete: (documentation: String) -> Unit,
    val onReopen: () -> Unit,
    val onAssign: (sequenceId: String?) -> Unit,
    val onDelete: () -> Unit,
)

/** Which form is open over the plan. Saveable so rotation keeps the user mid-question. */
enum class PlanDialog { Edit, Complete, Assign, Delete }

@Composable
private fun PlanDialogs(dialog: PlanDialog?, plan: HelmPlan, actions: PlanDetailActions, close: () -> Unit) {
    // Each form closes on submit: the verdict is the write line's to say, and a
    // form left open over a refused write would read as "still saving".
    when (dialog) {
        null -> Unit
        PlanDialog.Edit -> EditPlanDialog(
            initialTitle = plan.title,
            initialDescription = plan.description,
            onSave = { title, description -> close(); actions.onEdit(title, description) },
            onCancel = close,
        )
        PlanDialog.Complete -> CompletePlanDialog(
            onComplete = { documentation -> close(); actions.onComplete(documentation) },
            onCancel = close,
        )
        PlanDialog.Assign -> AssignLaneDialog(
            lanes = actions.lanes,
            currentLaneId = plan.sequenceId,
            onPick = { laneId -> close(); if (laneId != plan.sequenceId) actions.onAssign(laneId) },
            onCancel = close,
        )
        PlanDialog.Delete -> ConfirmDelete(
            message = stringResource(R.string.plan_confirm_delete, plan.title),
            onConfirm = { close(); actions.onDelete() },
            onCancel = close,
        )
    }
}

@Composable
private fun PlanBody(
    plan: LoadView<HelmPlan>,
    contexts: LoadView<List<HelmPlanContextRef>>,
    onRefresh: () -> Unit,
    actions: PlanDetailActions,
    onDialog: (PlanDialog) -> Unit,
    modifier: Modifier,
) {
    LoadBody(
        view = plan,
        loadingText = stringResource(R.string.plan_detail_loading),
        emptyText = stringResource(R.string.plan_detail_loading),
        // A plan that arrived is never empty — it has at least a title. The
        // empty branch exists for the list surfaces; here it cannot be reached.
        isEmpty = { false },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { shown ->
        val fields = PlanFields.of(shown)
        val contextsTitle = stringResource(R.string.detail_label_contexts)
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            item(key = "head") { PlanHead(shown) }
            item(key = "actions") { PlanActionRow(shown.status, actions, onDialog) }
            items(fields.size) { index -> DetailFieldBlock(fields[index]) }
            item(key = "contexts") { SectionHeader(contextsTitle) }
            contextItems(contexts)
        }
    }
}

/**
 * The plan's write affordances, under its heading. State moves come from
 * [PlanStateActions] so only moves the desktop accepts are offered; the ones
 * that need no input fire at once, Done opens the documentation form.
 * Wrapping because a phone cannot fit every move and every glyph on one line.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlanActionRow(status: PlanStatus, actions: PlanDetailActions, onDialog: (PlanDialog) -> Unit) {
    FlowRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        verticalArrangement = Arrangement.Center,
    ) {
        for (move in PlanStateActions.of(status)) {
            StateMoveChip(move) {
                when (move) {
                    PlanStateAction.Planning -> actions.onSetState(PlanStatus.Planning)
                    PlanStateAction.Ready -> actions.onSetState(PlanStatus.Ready)
                    PlanStateAction.Done -> onDialog(PlanDialog.Complete)
                    PlanStateAction.Reopen -> actions.onReopen()
                }
            }
        }
        GlyphButton(
            glyph = stringResource(R.string.control_glyph_rename),
            description = stringResource(R.string.plan_action_edit),
            onClick = { onDialog(PlanDialog.Edit) },
        )
        GlyphButton(
            glyph = stringResource(R.string.plan_assign_glyph),
            description = stringResource(R.string.plan_assign_title),
            onClick = { onDialog(PlanDialog.Assign) },
        )
        GlyphButton(
            glyph = stringResource(R.string.artifacts_glyph_delete),
            description = stringResource(R.string.plan_action_delete),
            onClick = { onDialog(PlanDialog.Delete) },
        )
    }
}

/** A state move, worn as the pill of the state it moves TO so the target is recognisable at a glance. */
@Composable
private fun StateMoveChip(move: PlanStateAction, onClick: () -> Unit) {
    val (label, color) = when (move) {
        PlanStateAction.Planning -> stringResource(R.string.plan_move_to, stringResource(PlanStatus.Planning.labelRes)) to PlanStatus.Planning.pillColor
        PlanStateAction.Ready -> stringResource(R.string.plan_move_to, stringResource(PlanStatus.Ready.labelRes)) to PlanStatus.Ready.pillColor
        PlanStateAction.Done -> stringResource(R.string.plan_move_to, stringResource(PlanStatus.Done.labelRes)) to HelmColors.Accent
        PlanStateAction.Reopen -> stringResource(R.string.plan_action_reopen) to HelmColors.Accent
    }
    Box(
        modifier = Modifier
            .heightIn(min = HelmSize.TouchTarget)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Pill(text = label, color = color)
    }
}

/** The heading: the title, with the status pill that the list row also wears. */
@Composable
private fun PlanHead(plan: HelmPlan) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        Text(
            text = plan.title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm)) {
            Pill(text = stringResource(plan.status.labelRes), color = plan.status.pillColor)
        }
    }
}

/**
 * The refs section's rows, one [LoadView] branch each.
 *
 * Written against the LazyListScope rather than as a nested [LoadBody]: the body
 * above is already scrolling, and a second full-height state machine inside it
 * would either collapse to nothing or fight the outer scroll.
 */
private fun LazyListScope.contextItems(
    contexts: LoadView<List<HelmPlanContextRef>>,
) {
    when (contexts) {
        LoadView.Loading -> item(key = "ctx:loading") {
            SectionNote(res = R.string.plan_contexts_loading)
        }

        is LoadView.Failed -> item(key = "ctx:failed") {
            SectionMessage(text = contexts.message, danger = true)
        }

        is LoadView.Ready -> if (contexts.data.isEmpty()) {
            item(key = "ctx:empty") { SectionNote(res = R.string.plan_contexts_empty) }
        } else {
            items(contexts.data.size) { index -> ContextRefRow(contexts.data[index]) }
        }
    }
}

@Composable
private fun ContextRefRow(ref: HelmPlanContextRef) {
    Column {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        ) {
            Text(
                text = ref.type.ifBlank { ref.id },
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
            )
            // The SOURCE is the part a reader cannot get anywhere else: whether
            // this context is the plan's own, inherited from its lane, or both.
            Text(
                text = stringResource(R.string.plan_context_ref_sub, ref.source.ifBlank { UNKNOWN_SOURCE }, ref.id),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Hairline(color = HelmColors.Separator)
    }
}

@Composable
private fun SectionHeader(text: String) {
    Column {
        Hairline(color = HelmColors.Separator)
        Text(
            text = text.uppercase(),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        )
    }
}

/** A calm in-section aside. A section's FAILURE is [SectionMessage] in danger. */
@Composable
private fun SectionNote(res: Int) {
    SectionMessage(text = stringResource(res), danger = false)
}

@Composable
private fun SectionMessage(text: String, danger: Boolean) {
    Text(
        text = text,
        color = if (danger) HelmColors.Danger else HelmColors.Faint,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
    )
}

/** A ref the desktop sent with no source. Shown, never guessed at. */
private const val UNKNOWN_SOURCE = "?"
