package com.potatomotato.helm.ui.plans

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.HelmReferences
import com.potatomotato.helm.ui.components.CopyGlyphButton
import com.potatomotato.helm.ui.components.GlyphButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.HelmRow
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.Pill
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The plan board — every plan of ONE scope, in its sequence lane.
 *
 * IT DOES NOT KNOW WHAT ITS SCOPE IS, and that is the whole design. The top
 * level points it at the selected project's canonical path; an open session
 * points it at its own working directory. Both hand it the same three already-
 * resolved things, so there is one board rather than a top-level one and an
 * in-session one drifting apart.
 *
 * [sequences] arrives as its own [LoadView] because the lanes are a SECOND call:
 * either answer can land first, and lanes that have not arrived must not hold
 * the plans back. A board with no lanes yet is the ungrouped board, which is a
 * correct — if temporary — reading of what is known.
 *
 * THE FRONTIER IS READ OFF THE ROWS, by [PlanStartability], because the rows
 * carry the dependency edges it needs — no second ask, and none of the rules
 * here: this file draws, those files decide.
 *
 * [collapsedLaneIds] and [onToggleLane] keep the folding OUTSIDE this composable.
 * Which lanes are shut is where the user is, like the open tab and the open
 * plan, so the caller holds it across rotation and both plan surfaces fold the
 * same lanes. A folded lane keeps its header — and its count, which is what
 * makes the fold readable rather than a list that lost rows.
 */
@Composable
fun PlanList(
    plans: LoadView<List<HelmPlanSummary>>,
    sequences: LoadView<List<HelmPlanSequence>>,
    collapsedLaneIds: Set<String>,
    onToggleLane: (String) -> Unit,
    onOpen: (HelmPlanSummary) -> Unit,
    onSpawn: (HelmPlanSummary) -> Unit,
    onRefresh: () -> Unit,
    write: PlanWrite,
    onDismissWrite: () -> Unit,
    onCreate: (title: String, description: String, type: String?, autoImplement: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    // The new-plan form is local: it is a question over the board, not a place.
    var creating by rememberSaveable { mutableStateOf(false) }
    Box(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Above the LoadBody, not inside it, so an EMPTY board — exactly
            // where a first plan is wanted — still offers it.
            GhostButton(
                text = stringResource(R.string.plan_new_action),
                onClick = { creating = true },
                modifier = Modifier.padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            )
            PlanWriteLine(write, onDismissWrite)
            PlanBoard(plans, sequences, collapsedLaneIds, onToggleLane, onOpen, onSpawn, onRefresh, Modifier.weight(1f))
        }
        if (creating) {
            NewPlanDialog(
                onCreate = { title, description, type, autoImplement ->
                    creating = false
                    onCreate(title, description, type, autoImplement)
                },
                onCancel = { creating = false },
            )
        }
    }
}

@Composable
private fun PlanBoard(
    plans: LoadView<List<HelmPlanSummary>>,
    sequences: LoadView<List<HelmPlanSequence>>,
    collapsedLaneIds: Set<String>,
    onToggleLane: (String) -> Unit,
    onOpen: (HelmPlanSummary) -> Unit,
    onSpawn: (HelmPlanSummary) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier,
) {
    LoadBody(
        view = plans,
        loadingText = stringResource(R.string.plans_loading),
        emptyText = stringResource(R.string.plans_empty),
        isEmpty = { it.isEmpty() },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { rows ->
        val lanes = (sequences as? LoadView.Ready)?.data.orEmpty()
        val startableIds = PlanStartability.of(rows)
        PlanBuckets(
            buckets = PlanGrouping.group(rows, lanes, startableIds),
            collapsedLaneIds = collapsedLaneIds,
            onToggleLane = onToggleLane,
            onOpen = onOpen,
            onSpawn = onSpawn,
        )
    }
}

@Composable
private fun PlanBuckets(
    buckets: List<PlanBucket>,
    collapsedLaneIds: Set<String>,
    onToggleLane: (String) -> Unit,
    onOpen: (HelmPlanSummary) -> Unit,
    onSpawn: (HelmPlanSummary) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        for (bucket in buckets) {
            // The ungrouped bucket's header says so rather than being unlabelled:
            // an unheaded run of rows under the last lane reads as part of it.
            // It folds like any other, under a key no lane can collide with.
            val laneKey = bucket.sequence?.id ?: UNGROUPED_KEY
            val collapsed = laneKey in collapsedLaneIds
            item(key = "lane:$laneKey") {
                LaneHeader(
                    sequence = bucket.sequence,
                    count = bucket.plans.size,
                    collapsed = collapsed,
                    onToggle = { onToggleLane(laneKey) },
                )
            }
            if (collapsed) continue
            for (plan in bucket.plans) {
                item(key = plan.id) {
                    PlanRow(
                        plan = plan,
                        onClick = { onOpen(plan) },
                        onSpawn = { onSpawn(plan) },
                    )
                }
            }
        }
    }
}

/**
 * A lane's name, or the ungrouped tail's. [sequence] null means the tail.
 *
 * The WHOLE header is the control, not a small chevron beside it: a fold is a
 * coarse gesture and a thumb-sized target is the difference between tidying the
 * board and missing. The count stays visible while folded so a shut lane reads
 * as "eight plans hidden here" rather than as a lane that emptied.
 */
@Composable
private fun LaneHeader(
    sequence: HelmPlanSequence?,
    count: Int,
    collapsed: Boolean,
    onToggle: () -> Unit,
) {
    Column {
        Hairline(color = HelmColors.Separator)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .clickable(
                    // The label is what a screen reader announces for the tap,
                    // which is the only place the fold names itself.
                    onClickLabel = stringResource(
                        if (collapsed) R.string.plans_lane_expand else R.string.plans_lane_collapse,
                    ),
                    onClick = onToggle,
                )
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Text(
                text = if (collapsed) CARET_CLOSED else CARET_OPEN,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
            Text(
                text = (sequence?.title ?: stringResource(R.string.plans_ungrouped)).uppercase(),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = count.toString(),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun PlanRow(plan: HelmPlanSummary, onClick: () -> Unit, onSpawn: () -> Unit) {
    HelmRow(
        title = plan.title,
        onClick = onClick,
        // The row's actions ride on line 2, not the right edge: on a phone the
        // right edge is where the title needs its width.
        subtitle = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                // A plan with no P-00xx name yet shows none: the human id is
                // the desktop's to mint, and inventing one here would put a
                // label on screen no other surface would agree with.
                plan.humanId?.takeIf { it.isNotBlank() }?.let { humanId ->
                    Text(
                        text = humanId,
                        color = HelmColors.Dim,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                // The plan's own state, always. "Ready to start" (no unmet
                // prerequisites) read as a state and hid the real one.
                Pill(text = stringResource(plan.status.labelRes), color = plan.status.pillColor)
                Spacer(modifier = Modifier.weight(1f))
                CopyGlyphButton(text = HelmReferences.plan(plan))
                // Its own target, beside copy: spawning is not opening the plan.
                GlyphButton(
                    glyph = stringResource(R.string.plans_spawn_glyph),
                    description = stringResource(R.string.plans_spawn_description),
                    onClick = onSpawn,
                )
            }
        },
    )
}

/** The fold's own marker: pointing right is shut, pointing down is open. */
private const val CARET_CLOSED = "›"
private const val CARET_OPEN = "⌄"

/** The ungrouped bucket has no id, so the list key needs one that is not a lane's. */
private const val UNGROUPED_KEY = "ungrouped"
