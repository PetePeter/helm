package com.potatomotato.helm.ui.sequences

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanSequence
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
    modifier: Modifier = Modifier,
) {
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
