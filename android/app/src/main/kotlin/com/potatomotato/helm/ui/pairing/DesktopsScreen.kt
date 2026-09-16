package com.potatomotato.helm.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.PairedDesktop
import com.potatomotato.helm.ui.components.DialogAction
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.ScrimDialog
import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.ui.components.StateDot
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The desktops this phone knows, and which one it is on.
 *
 * WHY THIS SCREEN EXISTS: pairing more than one desktop has always worked — the
 * keys are stored per machineId — but nothing said so. Without a list, a second
 * pairing is invisible, the first cannot be revoked, and "am I talking to the
 * office machine or the one at home?" has no answer anywhere in the app.
 *
 * ONE AT A TIME is not enforced here and must not be: the phone advertises and
 * the desktop connects, so the radio already refuses a second central. This
 * screen reports that fact rather than deciding it.
 */
@Composable
fun DesktopsScreen(
    desktops: List<PairedDesktop>,
    linkState: LinkState,
    onRename: (machineId: String, label: String) -> Unit,
    onForget: (machineId: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // The machineId under edit, not the row: the list is re-derived on every
    // change, and holding a stale copy would rename whatever took its place.
    var editing by remember { mutableStateOf<String?>(null) }
    val underEdit = desktops.firstOrNull { it.machineId == editing }

    Box(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Column(modifier = Modifier.fillMaxSize()) {
            HelmAppBar(
                title = stringResource(R.string.desktops_title),
                linkState = linkState,
                onBack = onBack,
            )

            if (desktops.isEmpty()) {
                Text(
                    text = stringResource(R.string.desktops_empty),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(HelmSpacing.Gutter),
                )
                return@Column
            }

            LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                items(desktops, key = { it.machineId }) { desktop ->
                    DesktopRow(desktop = desktop, onClick = { editing = desktop.machineId })
                    Hairline(color = HelmColors.Separator)
                }
            }

            Text(
                text = stringResource(R.string.desktops_footnote),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(HelmSpacing.Gutter),
            )
        }

        if (underEdit != null) {
            DesktopDialog(
                desktop = underEdit,
                onRename = { label ->
                    onRename(underEdit.machineId, label)
                    editing = null
                },
                onForget = {
                    onForget(underEdit.machineId)
                    editing = null
                },
                onDismiss = { editing = null },
            )
        }
    }
}

/**
 * The machineId is shown under the name, always. It is the only thing that
 * matches what the desktop's own device list shows, so it is what the user needs
 * when the two disagree — and it is the only way to tell apart two desktops the
 * user has not named.
 */
@Composable
private fun DesktopRow(desktop: PairedDesktop, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        // Idle rather than absent for an unlinked desktop: a missing dot reads
        // as a broken row, a dark one reads as "not this one".
        StateDot(state = if (desktop.linked) SessionState.Active else SessionState.Idle)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = desktop.label,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = desktop.machineId,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (desktop.linked) {
            Text(
                text = stringResource(R.string.link_state_linked),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

/**
 * Rename and forget, together, because they are the only two things a paired
 * desktop can have done to it and splitting them would cost a second screen.
 *
 * Forget sits below Save and is drawn quietly: it is the destructive one, and
 * the user arrived here to type a name far more often than to revoke a key.
 */
@Composable
private fun DesktopDialog(
    desktop: PairedDesktop,
    onRename: (String) -> Unit,
    onForget: () -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember(desktop.machineId) { mutableStateOf(desktop.label) }
    val fieldLabel = stringResource(R.string.desktops_rename_label)

    ScrimDialog(
        title = stringResource(R.string.desktops_rename_title),
        body = desktop.machineId,
        onDismiss = onDismiss,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        ) {
            BasicTextField(
                value = name,
                onValueChange = { name = it },
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
                cursorBrush = SolidColor(HelmColors.Accent),
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onRename(name) }),
                // BasicTextField carries no label of its own — without this,
                // TalkBack reaches an anonymous edit box.
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = fieldLabel },
            )
        }
        // Blank is a legitimate answer: it clears the nickname and puts the row
        // back on its derived default, so Save is never dark.
        DialogAction(text = stringResource(R.string.desktops_rename_save), onClick = { onRename(name) })
        DialogAction(
            text = stringResource(R.string.desktops_forget),
            onClick = onForget,
            emphasised = false,
        )
        DialogAction(
            text = stringResource(R.string.pairing_cancel),
            onClick = onDismiss,
            emphasised = false,
        )
    }
}
