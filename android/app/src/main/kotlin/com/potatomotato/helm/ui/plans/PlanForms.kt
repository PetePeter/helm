package com.potatomotato.helm.ui.plans

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.data.PlanWriteKind
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.ScrimDialog
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The plan and sequence write forms (P-0812). Every one sits on [ScrimDialog]
 * so it asks the way the rest of the app asks, and every one hands its values
 * UP rather than calling the client: the screens own the write, these own only
 * what the user typed.
 */

/** The plan types `plan_create` accepts; null is "no type", which the client omits from the wire. */
private val PLAN_TYPES = listOf(null, "bug", "feature", "research")

/** New plan: title, description, type and autoImplement — the plan_create fields worth a phone. */
@Composable
fun NewPlanDialog(
    onCreate: (title: String, description: String, type: String?, autoImplement: Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableStateOf<String?>(null) }
    var autoImplement by rememberSaveable { mutableStateOf(false) }
    ScrimDialog(title = stringResource(R.string.plan_new_title), onDismiss = onCancel) {
        FormField(stringResource(R.string.plan_field_title), title, { title = it })
        FormField(stringResource(R.string.plan_field_description), description, { description = it }, singleLine = false)
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm)) {
            for (option in PLAN_TYPES) {
                Choice(
                    text = option ?: stringResource(R.string.plan_type_none),
                    selected = type == option,
                    onClick = { type = option },
                )
            }
        }
        Choice(
            text = stringResource(R.string.plan_field_auto_implement),
            selected = autoImplement,
            onClick = { autoImplement = !autoImplement },
        )
        ConfirmAction(
            text = stringResource(R.string.plan_new_confirm),
            enabled = PlanStateActions.canSaveTitle(title),
            onClick = { onCreate(title, description, type, autoImplement) },
        )
        GhostButton(text = stringResource(R.string.plan_form_cancel), onClick = onCancel)
    }
}

/** Edit a plan's title and description. */
@Composable
fun EditPlanDialog(
    initialTitle: String,
    initialDescription: String,
    onSave: (title: String, description: String) -> Unit,
    onCancel: () -> Unit,
) {
    var title by rememberSaveable { mutableStateOf(initialTitle) }
    var description by rememberSaveable { mutableStateOf(initialDescription) }
    ScrimDialog(title = stringResource(R.string.plan_edit_title), onDismiss = onCancel) {
        FormField(stringResource(R.string.plan_field_title), title, { title = it })
        FormField(stringResource(R.string.plan_field_description), description, { description = it }, singleLine = false)
        ConfirmAction(
            text = stringResource(R.string.plan_form_save),
            enabled = PlanStateActions.canSaveTitle(title),
            onClick = { onSave(title, description) },
        )
        GhostButton(text = stringResource(R.string.plan_form_cancel), onClick = onCancel)
    }
}

/**
 * Mark done. The desktop refuses completion without documentation, so the
 * phone asks for it up front and greys the confirm until it would pass.
 */
@Composable
fun CompletePlanDialog(onComplete: (documentation: String) -> Unit, onCancel: () -> Unit) {
    var documentation by rememberSaveable { mutableStateOf("") }
    ScrimDialog(
        title = stringResource(R.string.plan_complete_title),
        body = stringResource(R.string.plan_complete_body, PlanStateActions.MIN_COMPLETION_CHARS),
        onDismiss = onCancel,
    ) {
        FormField(stringResource(R.string.plan_field_documentation), documentation, { documentation = it }, singleLine = false)
        ConfirmAction(
            text = stringResource(R.string.plan_complete_confirm),
            enabled = PlanStateActions.canComplete(documentation),
            onClick = { onComplete(documentation) },
        )
        GhostButton(text = stringResource(R.string.plan_form_cancel), onClick = onCancel)
    }
}

/** Put the plan in a lane, or in none. The current lane is marked, never hidden. */
@Composable
fun AssignLaneDialog(
    lanes: List<HelmPlanSequence>,
    currentLaneId: String?,
    onPick: (String?) -> Unit,
    onCancel: () -> Unit,
) {
    ScrimDialog(title = stringResource(R.string.plan_assign_title), onDismiss = onCancel) {
        Column(modifier = Modifier.heightIn(max = HelmSize.TouchTarget * LANE_ROWS_VISIBLE).verticalScroll(rememberScrollState())) {
            LaneChoice(stringResource(R.string.plans_ungrouped), currentLaneId == null) { onPick(null) }
            for (lane in lanes.sortedWith(PlanGrouping.laneOrder())) {
                LaneChoice(lane.title, lane.id == currentLaneId) { onPick(lane.id) }
            }
        }
        GhostButton(text = stringResource(R.string.plan_form_cancel), onClick = onCancel)
    }
}

/** Create or edit a sequence lane: title and mission, the two fields a phone edits. */
@Composable
fun SequenceFormDialog(
    heading: String,
    initialTitle: String,
    initialMission: String,
    onSave: (title: String, mission: String) -> Unit,
    onCancel: () -> Unit,
) {
    var title by rememberSaveable { mutableStateOf(initialTitle) }
    var mission by rememberSaveable { mutableStateOf(initialMission) }
    ScrimDialog(title = heading, onDismiss = onCancel) {
        FormField(stringResource(R.string.plan_field_title), title, { title = it })
        FormField(stringResource(R.string.sequence_field_mission), mission, { mission = it }, singleLine = false)
        ConfirmAction(
            text = stringResource(R.string.plan_form_save),
            enabled = PlanStateActions.canSaveTitle(title),
            onClick = { onSave(title, mission) },
        )
        GhostButton(text = stringResource(R.string.plan_form_cancel), onClick = onCancel)
    }
}

/**
 * The verdict of the last plan/sequence write, as one tappable line. Failure is
 * the part that matters: a refused write must be READ, not inferred from a
 * board that simply did not change. Tapping dismisses it.
 */
@Composable
fun PlanWriteLine(state: PlanWrite, onDismiss: () -> Unit) {
    val (text, color) = when (state) {
        PlanWrite.Idle -> return
        is PlanWrite.InFlight -> stringResource(R.string.plan_write_in_flight) to HelmColors.Faint
        is PlanWrite.Done -> stringResource(R.string.plan_write_done, writeLabel(state.kind)) to HelmColors.Accent
        is PlanWrite.Failed -> stringResource(R.string.plan_write_failed, writeLabel(state.kind), state.message) to HelmColors.Danger
    }
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = state !is PlanWrite.InFlight, onClick = onDismiss)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
    )
}

@Composable
private fun writeLabel(kind: PlanWriteKind): String = stringResource(
    when (kind) {
        PlanWriteKind.CreatePlan -> R.string.plan_write_create_plan
        PlanWriteKind.UpdatePlan -> R.string.plan_write_update_plan
        PlanWriteKind.SetState -> R.string.plan_write_set_state
        PlanWriteKind.Complete -> R.string.plan_write_complete
        PlanWriteKind.Reopen -> R.string.plan_write_reopen
        PlanWriteKind.DeletePlan -> R.string.plan_write_delete_plan
        PlanWriteKind.AssignSequence -> R.string.plan_write_assign
        PlanWriteKind.CreateSequence -> R.string.plan_write_create_sequence
        PlanWriteKind.UpdateSequence -> R.string.plan_write_update_sequence
        PlanWriteKind.DeleteSequence -> R.string.plan_write_delete_sequence
        PlanWriteKind.ClearUnused -> R.string.plan_write_clear_unused
    },
)

/**
 * One labelled text box, styled like the rename field so every form in the app
 * types the same way. Multi-line boxes cap their height and scroll inside: a
 * plan description can be long, and an unbounded box would push the confirm
 * off the dialog.
 */
@Composable
private fun FormField(label: String, value: String, onChange: (String) -> Unit, singleLine: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs)) {
        Text(text = label, color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
                cursorBrush = SolidColor(HelmColors.Accent),
                singleLine = singleLine,
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (singleLine) Modifier else Modifier.heightIn(min = HelmSize.TouchTarget * 2, max = HelmSize.TouchTarget * 4))
                    // BasicTextField has no label of its own; without this TalkBack meets an anonymous box.
                    .semantics { contentDescription = label },
            )
        }
    }
}

/** A toggle that reads as one: accent and a check when on, so colour is never the only signal. */
@Composable
private fun Choice(text: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text = if (selected) stringResource(R.string.plan_choice_selected, text) else text,
        color = if (selected) HelmColors.Accent else HelmColors.Dim,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(HelmColors.Surface2)
            .border(HelmSize.Hairline, if (selected) HelmColors.Accent else HelmColors.Line, RoundedCornerShape(HelmRadius.Pill))
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    )
}

@Composable
private fun LaneChoice(title: String, current: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HelmSize.TouchTarget)
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (current) stringResource(R.string.plan_choice_selected, title) else title,
            color = if (current) HelmColors.Accent else HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The confirm, drawn like the rename dialog's: accent text, faint when the form would be refused. */
@Composable
private fun ConfirmAction(text: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        color = if (enabled) HelmColors.Accent else HelmColors.Faint,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = HelmSpacing.Md),
    )
}

/** How many lanes the picker shows before it scrolls. */
private const val LANE_ROWS_VISIBLE = 6
