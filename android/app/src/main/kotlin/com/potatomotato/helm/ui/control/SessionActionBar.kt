package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmTheme

/** Flat tablet action list; the phone sheet and this bar consume the same entries. */
@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun SessionActionBar(
    actions: SessionActions,
    sessionName: String,
    clis: List<HelmCli>,
    onAction: (SessionAction) -> Unit,
    onRename: (String) -> Unit,
    onSwitchCli: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val dialogState = rememberSessionActionDialogState()
    Box(modifier = modifier.fillMaxWidth()) {
        Column {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Sm),
                horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                for (group in actions.barGroups) {
                    Column(
                        modifier = Modifier.widthIn(max = 600.dp),
                        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
                    ) {
                        Text(
                            text = stringResource(group.group.titleRes),
                            color = HelmColors.Dim,
                            style = MaterialTheme.typography.labelSmall,
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
                            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
                        ) {
                            for (entry in group.actions) {
                                SessionActionBarButton(entry) {
                                    dialogState.select(entry)?.let(onAction)
                                }
                            }
                        }
                    }
                }
            }
        }
        SessionActionDialogs(
            state = dialogState,
            sessionName = sessionName,
            clis = clis,
            onAction = onAction,
            onRename = onRename,
            onSwitchCli = onSwitchCli,
            showConfirmationDialog = true,
        )
    }
}

@Composable
private fun SessionActionBarButton(entry: SessionActionEntry, onClick: () -> Unit) {
    val color = entry.action.labelColor(entry.permitted)
    Row(
        modifier = Modifier
            .then(if (entry.permitted) Modifier else Modifier.alpha(FORBIDDEN_ACTION_ALPHA))
            .clip(RoundedCornerShape(HelmRadius.Sm))
            .background(HelmColors.Surface)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Sm))
            .clickable(enabled = entry.permitted, onClick = onClick)
            .padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(stringResource(entry.glyphRes), color = color, style = MaterialTheme.typography.bodyMedium)
        Text(
            text = stringResource(entry.labelRes),
            color = color,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        entry.toggleEnabled?.let { enabled ->
            Switch(checked = enabled, onCheckedChange = null, enabled = entry.permitted)
        }
    }
}

@Preview(name = "Session action bar", showBackground = true, widthDp = 1000)
@Composable
private fun SessionActionBarPreview() {
    HelmTheme {
        val capabilities = remember {
            Capabilities.Known(SessionAction.entries.map { it.tool }.toSet())
        }
        val actions = remember { sessionActions(keepWarm = true, frozen = false, capabilities = capabilities) }
        SessionActionBar(
            actions = actions,
            sessionName = "worker-P-1206",
            clis = emptyList(),
            onAction = {},
            onRename = {},
            onSwitchCli = {},
            modifier = Modifier.background(HelmColors.Bg),
        )
    }
}

/** Forbidden rows receive the same whole-control fade as the phone sheet. */
private const val FORBIDDEN_ACTION_ALPHA = 0.3f
