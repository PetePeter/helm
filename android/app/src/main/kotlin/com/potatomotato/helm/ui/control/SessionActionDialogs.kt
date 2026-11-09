package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.SCRIM_ALPHA
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/** Shared selection state: both presenters route the same action through the same gates. */
@Stable
internal class SessionActionDialogState {
    var confirmation by mutableStateOf<SessionActionEntry?>(null)
        private set
    var renaming by mutableStateOf(false)
        private set
    var switching by mutableStateOf(false)
        private set

    fun select(entry: SessionActionEntry): SessionAction? {
        if (!entry.permitted) return null
        return when {
            entry.confirmation != null -> {
                confirmation = entry
                null
            }
            entry.action == SessionAction.Rename -> {
                renaming = true
                null
            }
            entry.action == SessionAction.SwitchCli -> {
                switching = true
                null
            }
            else -> entry.action
        }
    }

    fun confirm(): SessionAction? {
        val action = confirmation?.action
        confirmation = null
        return action
    }

    fun cancelConfirmation() {
        confirmation = null
    }

    fun finishRename() {
        renaming = false
    }

    fun finishSwitch() {
        switching = false
    }
}

@Composable
internal fun rememberSessionActionDialogState(): SessionActionDialogState = remember { SessionActionDialogState() }

/**
 * The confirmation row: what will happen, then the answer that does it and the
 * one that does not. The confirm's colour carries the verdict — Danger for the
 * action that loses something, Accent for one that is merely expensive.
 */
@Composable
internal fun SessionActionConfirmation(
    entry: SessionActionEntry,
    sessionName: String,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Gutter),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        SessionActionConfirmationContent(entry, sessionName, onConfirm, onCancel)
    }
}

/** Shared confirmation, rename, and CLI-picker overlays for both action presenters. */
@Composable
internal fun SessionActionDialogs(
    state: SessionActionDialogState,
    sessionName: String,
    clis: List<HelmCli>,
    onAction: (SessionAction) -> Unit,
    onRename: (String) -> Unit,
    onSwitchCli: (String) -> Unit,
    showConfirmationDialog: Boolean = false,
) {
    if (showConfirmationDialog) {
        state.confirmation?.let { entry ->
            SessionActionConfirmationDialog(
                entry = entry,
                sessionName = sessionName,
                onConfirm = { state.confirm()?.let(onAction) },
                onCancel = state::cancelConfirmation,
            )
        }
    }
    if (state.switching) {
        ScreenLevelActionDialog(onDismiss = state::finishSwitch) {
            CliPickerDialog(
                clis = clis,
                onPick = {
                    state.finishSwitch()
                    onSwitchCli(it)
                },
                onCancel = state::finishSwitch,
            )
        }
    }
    if (state.renaming) {
        ScreenLevelActionDialog(onDismiss = state::finishRename) {
            RenameDialog(
                currentName = sessionName,
                onRename = {
                    state.finishRename()
                    onRename(it)
                },
                onCancel = state::finishRename,
            )
        }
    }
}

@Composable
private fun SessionActionConfirmationDialog(
    entry: SessionActionEntry,
    sessionName: String,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    ScreenLevelActionDialog(onDismiss = onCancel) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
                .clickable(onClick = onCancel),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(HelmSpacing.Gutter)
                    .clip(RoundedCornerShape(HelmRadius.Md))
                    .background(HelmColors.Surface)
                    .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                    .pointerInput(Unit) {}
                    .padding(HelmSpacing.Lg),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
            ) {
                SessionActionConfirmationContent(entry, sessionName, onConfirm, onCancel)
            }
        }
    }
}

/** Reuse the app's scrim over Dialog's separate window without adding a second platform dim. */
@Composable
private fun ScreenLevelActionDialog(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        val dialogWindow = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { dialogWindow?.setDimAmount(0f) }
        content()
    }
}

@Composable
private fun SessionActionConfirmationContent(
    entry: SessionActionEntry,
    sessionName: String,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    val copy = checkNotNull(entry.confirmation)
    Text(
        text = stringResource(copy.messageRes, sessionName),
        color = HelmColors.Txt,
        style = MaterialTheme.typography.bodyLarge,
    )
    // The destructive one is NOT the loud accent button: accent means the
    // thing the user came here to do, and that is never losing a session.
    Text(
        text = stringResource(copy.yesRes),
        color = copy.confirmColor,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .clickable(onClick = onConfirm)
            .padding(vertical = HelmSpacing.Md),
    )
    GhostButton(text = stringResource(copy.noRes), onClick = onCancel)
}

/**
 * Rename, asked in place. Hand-drawn like the sheet itself, centred on the
 * scrim it sits on. The field is prefilled with the current name so the edit
 * starts from what is true, and Rename stays dark until the name has actually
 * changed — a confirm that fires on a no-op trains tapping through it.
 */
@Composable
private fun RenameDialog(currentName: String, onRename: (String) -> Unit, onCancel: () -> Unit) {
    // Seeded as a TextFieldValue with the whole name selected: the common case
    // is a full rewrite, so the first keystroke replaces it instead of appending.
    var name by remember {
        mutableStateOf(TextFieldValue(currentName, TextRange(0, currentName.length)))
    }
    val verdict = RenameRules.judge(currentName, name.text)
    val canRename = verdict == RenameRules.Verdict.Ok

    // The field takes focus as the dialog opens: the whole point of the dialog
    // is to type, and on a tablet with a keyboard attached that means now.
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
            // Tapping the darkness around the card is cancel, like the sheet.
            .clickable(onClick = onCancel),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                // Consume taps on the card so they never fall through to the
                // scrim: only a deliberate Cancel or a dismiss-tap cancels.
                .padding(HelmSpacing.Gutter)
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                // A bare pointer input, not an empty clickable: it keeps scrim
                // taps from falling through to Cancel without adding the
                // unlabeled no-op node an empty clickable puts in the tree.
                .pointerInput(Unit) {}
                .padding(HelmSpacing.Lg),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            val fieldLabel = stringResource(R.string.control_rename_title)
            val tooLongLabel = stringResource(R.string.control_rename_too_long)
            Text(fieldLabel, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium)
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
                    // Done on the keyboard is the confirm, not a dismissal.
                    keyboardActions = KeyboardActions(onDone = { if (canRename) onRename(name.text.trim()) }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester)
                        // The field is titled above, but BasicTextField carries
                        // no label of its own — without this, TalkBack reaches
                        // an anonymous edit box. The rule state rides along so
                        // an over-long name is announced as the reason the
                        // confirm is dark, not discovered by tapping it.
                        .semantics {
                            contentDescription = fieldLabel
                            if (verdict == RenameRules.Verdict.TooLong) error(tooLongLabel)
                        },
                )
            }
            Text(
                text = stringResource(R.string.control_rename_confirm),
                color = if (canRename) HelmColors.Accent else HelmColors.Faint,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(HelmRadius.Md))
                    .clickable(enabled = canRename, onClick = { onRename(name.text.trim()) })
                    .padding(vertical = HelmSpacing.Md),
            )
            GhostButton(text = stringResource(R.string.control_rename_cancel), onClick = onCancel)
        }
    }
}

/**
 * Switch CLI's picker: one row per CLI type this desktop offers. The session
 * continues in the picked CLI; the old one goes to the desktop's recycle bin.
 */
@Composable
private fun CliPickerDialog(clis: List<HelmCli>, onPick: (String) -> Unit, onCancel: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
            .clickable(onClick = onCancel),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(HelmSpacing.Gutter)
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                // Keeps card taps from falling through to the scrim's cancel.
                .pointerInput(Unit) {}
                .padding(HelmSpacing.Lg),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Text(
                text = stringResource(R.string.control_switch_cli_title),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
            )
            if (clis.isEmpty()) {
                Text(
                    text = stringResource(R.string.control_switch_cli_loading),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            for (cli in clis) {
                Text(
                    text = cli.name,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(HelmRadius.Md))
                        .clickable { onPick(cli.cliType) }
                        .padding(vertical = HelmSpacing.Md),
                )
            }
            GhostButton(text = stringResource(R.string.control_rename_cancel), onClick = onCancel)
        }
    }
}
