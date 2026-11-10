package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.components.HelmDropdownAnchor
import com.potatomotato.helm.ui.keyboard.keyboardPttEvents
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmTheme

/** Compact tablet action menus; the phone sheet consumes the same entries. */
@Composable
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
    Box(modifier = modifier) {
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs)) {
            for (group in actions.barGroups) {
                SessionActionGroupDropdown(group) { entry ->
                    dialogState.select(entry)?.let(onAction)
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
private fun SessionActionGroupDropdown(
    group: SessionActionBarGroupEntries,
    onSelect: (SessionActionEntry) -> Unit,
) {
    var expanded by remember(group.group) { mutableStateOf(false) }
    val menuShape = RoundedCornerShape(HelmRadius.Md)
    Box {
        HelmDropdownAnchor(
            label = stringResource(group.group.titleRes),
            expanded = expanded,
            onClick = { expanded = !expanded },
        )
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier
                .keyboardPttEvents()
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, menuShape)
                .widthIn(min = 180.dp),
            shape = menuShape,
            containerColor = HelmColors.Surface2,
        ) {
            for (entry in group.actions) {
                DropdownMenuItem(
                    modifier = if (entry.permitted) Modifier else Modifier.alpha(FORBIDDEN_ACTION_ALPHA),
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                        ) {
                            Text(
                                text = stringResource(entry.glyphRes),
                                color = HelmColors.Dim,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                text = stringResource(entry.labelRes),
                                color = entry.action.labelColor(entry.permitted),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    },
                    trailingIcon = if (entry.toggleEnabled == true) {
                        {
                            Text(
                                text = stringResource(R.string.context_glyph_check),
                                color = HelmColors.Accent,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    } else null,
                    enabled = entry.permitted,
                    onClick = {
                        expanded = false
                        onSelect(entry)
                    },
                )
            }
        }
    }
}

@Preview(name = "Session action menus", showBackground = true, widthDp = 1000)
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
