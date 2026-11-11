package com.potatomotato.helm.ui.sequences

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.CleanupState
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.theme.HelmColors

/**
 * The lane-management half of the merged Plans tab: what the old Sequences tab
 * offered, folded into the board so lanes are managed where they are seen.
 */
data class LaneTools(
    val onCreateSequence: (title: String, mission: String) -> Unit,
    val onClearUnused: () -> Unit,
    val onOpenSequence: (HelmPlanSequence) -> Unit,
)

/** "Clear unused", live only once the desktop's counts say there is something to clear. */
@Composable
fun ClearAction(cleanup: CleanupState, onClear: () -> Unit, modifier: Modifier = Modifier) {
    GhostButton(
        text = stringResource(R.string.sequence_clear_action),
        onClick = onClear,
        modifier = modifier,
        enabled = cleanup is CleanupState.Ready && !cleanup.counts.nothingToClear,
        contentColor = HelmColors.Danger,
    )
}
