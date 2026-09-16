package com.potatomotato.helm.ui.sequences

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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanSequence
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
    modifier: Modifier = Modifier,
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
