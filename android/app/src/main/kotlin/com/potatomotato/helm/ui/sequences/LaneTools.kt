package com.potatomotato.helm.ui.sequences

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.CleanupState
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The lane-management half of the merged Plans tab: what the old Sequences tab
 * offered, folded into the board so lanes are managed where they are seen.
 */
data class LaneTools(
    val onCreateSequence: (title: String, mission: String) -> Unit,
    val onClearUnused: () -> Unit,
    val onOpenSequence: (HelmPlanSequence) -> Unit,
)

/**
 * What "Clear unused" would remove, said BEFORE it is offered — the desktop's
 * cleanup counts, so the phone deletes exactly what the desktop dialog would.
 * The action greys at zero rather than asking to delete nothing.
 */
@Composable
fun CleanupRow(cleanup: CleanupState, onClear: () -> Unit) {
    val (text, color) = when (cleanup) {
        CleanupState.Idle, is CleanupState.Loading -> stringResource(R.string.sequence_cleanup_loading) to HelmColors.Faint
        is CleanupState.Failed -> cleanup.message to HelmColors.Danger
        is CleanupState.Ready -> stringResource(
            R.string.sequence_cleanup_counts,
            cleanup.counts.donePlans,
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
