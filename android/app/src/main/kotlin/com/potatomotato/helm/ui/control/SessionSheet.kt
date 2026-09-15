package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.answered
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Mockup screen 4 — the control sheet.
 *
 * Two rules make this screen honest, and they are the whole design:
 *
 * WHAT IS OFFERED COMES FROM THE GATE, never from a list written here. The rows
 * grey out from `__mobile_tools__` — the device's real permitted surface — which
 * is why "not permitted" is allowed to appear at all. That label is a ratified
 * divergence from the desktop's uniform-deny rule, defensible only because a
 * SAS-paired phone is the user's own device AND because the claim is true.
 *
 * A ROW THAT CANNOT WORK IS NOT DRAWN. Drafts are absent, not greyed: reachable
 * only through the CALLER's own session, from the phone's proxy identity they
 * would answer emptily rather than refuse. A live row that silently does nothing
 * is worse than no row, and "not permitted" would be a lie — the user IS
 * permitted; there is simply nothing to call. Artifacts is absent for a different
 * reason: it is a PLACE, not an action, so it is one of the session's tabs (see
 * SessionTab) and greys from the gate row by row on the screen it opens.
 *
 * The sheet is hand-drawn rather than a ModalBottomSheet: Material's sheet tints
 * its surface, and this design's elevation is a hairline on true black.
 */
@Composable
fun SessionSheet(
    sessionName: String,
    capabilities: Capabilities,
    onAction: (SessionAction) -> Unit,
    onRename: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Close is the only destructive action, so it alone confirms — and it names
    // the session, because "are you sure?" answers nothing. Nothing else
    // confirms: a prompt on every action trains people to tap through the one
    // that matters.
    var confirming by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }

    Box(modifier = modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
                .clickable(onClick = onDismiss),
        )

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = HelmRadius.Sheet, topEnd = HelmRadius.Sheet))
                .background(HelmColors.Surface)
                .padding(bottom = HelmSpacing.Sm),
        ) {
            GrabHandle()

            Text(
                text = sessionName,
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            )
            Hairline()

            if (confirming) {
                ConfirmClose(
                    sessionName = sessionName,
                    onConfirm = {
                        confirming = false
                        onAction(SessionAction.Close)
                    },
                    onCancel = { confirming = false },
                )
            } else {
                for (action in SHEET_ACTIONS) {
                    ActionRow(
                        action = action,
                        capabilities = capabilities,
                        onClick = {
                            when (action) {
                                SessionAction.Close -> confirming = true
                                // Rename needs a name before it can act, so it
                                // opens the dialog instead of firing at once.
                                SessionAction.Rename -> renaming = true
                                else -> onAction(action)
                            }
                        },
                    )
                }
            }
        }

        if (renaming) {
            RenameDialog(
                currentName = sessionName,
                onRename = {
                    renaming = false
                    onRename(it)
                },
                onCancel = { renaming = false },
            )
        }
    }
}

/**
 * The sheet's order, top to bottom: what you look at, what you tidy, what you
 * create, what you destroy. Destructive last, furthest from the reading position.
 */
private val SHEET_ACTIONS = listOf(
    SessionAction.Snapshot,
    SessionAction.Rename,
    SessionAction.Compact,
    SessionAction.Spawn,
    SessionAction.Close,
)

@Composable
private fun ActionRow(
    action: SessionAction,
    capabilities: Capabilities,
    onClick: () -> Unit,
) {
    val permitted = capabilities.permits(action)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            // The mockup fades the WHOLE row, tile included — colour alone did
            // not read as disabled next to a still-solid tile.
            .then(if (permitted) Modifier else Modifier.alpha(FORBIDDEN_ALPHA))
            .clickable(enabled = permitted, onClick = onClick)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        // Each glyph sits in its own inset tile — the mockup's 29dp rounded-8
        // Surface2 box — so the emoji never floats free at reading size.
        Box(
            modifier = Modifier
                .size(HelmSize.ActionTile)
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Sm)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(action.glyphRes),
                color = action.labelColor(permitted),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        Text(
            text = stringResource(action.labelRes),
            color = action.labelColor(permitted),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )

        // The reason, when there is an honest one to give. An unanswered
        // discovery says "checking…" rather than claiming a verdict the phone has
        // not been given — the row is unavailable either way, but only one of the
        // two states knows why.
        if (!permitted) {
            Text(
                text = stringResource(
                    if (capabilities.answered) R.string.control_not_permitted else R.string.control_asking,
                ),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun ConfirmClose(sessionName: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Gutter),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        Text(
            text = stringResource(R.string.control_confirm_close, sessionName),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyLarge,
        )
        // The destructive one is NOT the loud accent button: the accent means
        // "the thing you came here to do", and that is never losing a session.
        Text(
            text = stringResource(R.string.control_confirm_close_yes),
            color = HelmColors.Danger,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Md))
                .clickable(onClick = onConfirm)
                .padding(vertical = HelmSpacing.Md),
        )
        GhostButton(text = stringResource(R.string.control_confirm_close_no), onClick = onCancel)
    }
}

/**
 * Rename, asked in place. Hand-drawn like the sheet itself, centred on the
 * scrim it sits on. The field is prefilled with the current name so the edit
 * starts from what is true, and Rename stays dark until the name has actually
 * changed — a confirm that fires on a no-op trains tapping through it.
 */
@Composable
private fun RenameDialog(currentName: String, onRename: (String) -> Unit, onCancel: () -> Unit) {
    var name by remember { mutableStateOf(currentName) }
    val verdict = RenameRules.judge(currentName, name)
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
            Text(
                text = fieldLabel,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
            )
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
                    // Done on the keyboard is the confirm, not a dismissal —
                    // the same verb the dialog's own button carries.
                    keyboardActions = KeyboardActions(onDone = { if (canRename) onRename(name.trim()) }),
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
                    .clickable(enabled = canRename, onClick = { onRename(name.trim()) })
                    .padding(vertical = HelmSpacing.Md),
            )
            GhostButton(text = stringResource(R.string.control_rename_cancel), onClick = onCancel)
        }
    }
}

/** The drag affordance from the mockup. Decorative — the scrim is what dismisses. */
@Composable
private fun GrabHandle() {
    Box(modifier = Modifier.fillMaxWidth().padding(vertical = HelmSpacing.Sm), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .width(GRAB_WIDTH)
                .height(HelmSize.Hairline * GRAB_THICKNESS)
                .clip(RoundedCornerShape(HelmRadius.Pill))
                .background(HelmColors.Line),
        )
    }
}

/** The label colour: dim when unavailable, danger for the ones that destroy. */
internal fun SessionAction.labelColor(permitted: Boolean): Color = when {
    !permitted -> HelmColors.Faint
    this == SessionAction.Close || this == SessionAction.DeleteArtifact -> HelmColors.Danger
    else -> HelmColors.Txt
}

/**
 * Shared with the artifacts screens, whose rows are the same action shape drawn
 * in a list rather than a sheet: one definition, so a label or glyph cannot
 * drift between the two surfaces.
 */
internal val SessionAction.labelRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_action_snapshot
        SessionAction.Artifacts -> R.string.control_action_artifacts
        SessionAction.Rename -> R.string.control_action_rename
        SessionAction.Compact -> R.string.control_action_compact
        SessionAction.Spawn -> R.string.control_action_spawn
        SessionAction.Close -> R.string.control_action_close
        SessionAction.CreateArtifact -> R.string.artifacts_action_new
        SessionAction.ReviseArtifact -> R.string.artifacts_action_revise
        SessionAction.SaveArtifact -> R.string.artifacts_action_save
        SessionAction.DeleteArtifact -> R.string.artifacts_action_delete
    }

internal val SessionAction.glyphRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_glyph_snapshot
        SessionAction.Artifacts -> R.string.control_glyph_artifacts
        SessionAction.Rename -> R.string.control_glyph_rename
        SessionAction.Compact -> R.string.control_glyph_compact
        SessionAction.Spawn -> R.string.control_glyph_spawn
        SessionAction.Close -> R.string.control_glyph_close
        SessionAction.CreateArtifact -> R.string.artifacts_glyph_new
        SessionAction.ReviseArtifact -> R.string.artifacts_glyph_revise
        SessionAction.SaveArtifact -> R.string.artifacts_glyph_save
        SessionAction.DeleteArtifact -> R.string.artifacts_glyph_delete
    }

/** Dark enough to push the thread behind it back, never opaque. */
private const val SCRIM_ALPHA = 0.72f

/** The mockup greys a forbidden row to 30%, on top of the Faint colour. */
private const val FORBIDDEN_ALPHA = 0.3f
private const val GRAB_THICKNESS = 4
private val GRAB_WIDTH = HelmSize.TouchTarget
