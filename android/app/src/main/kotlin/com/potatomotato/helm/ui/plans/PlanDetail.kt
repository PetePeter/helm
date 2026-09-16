package com.potatomotato.helm.ui.plans

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.data.HelmPlanContextRef
import com.potatomotato.helm.ui.components.DetailFieldBlock
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.Pill
import com.potatomotato.helm.ui.theme.HelmColors
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
    modifier: Modifier = Modifier,
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
            items(fields.size) { index -> DetailFieldBlock(fields[index]) }
            item(key = "contexts") { SectionHeader(contextsTitle) }
            contextItems(contexts)
        }
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
