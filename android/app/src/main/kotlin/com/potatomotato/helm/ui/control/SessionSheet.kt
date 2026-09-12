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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
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
 * A ROW THAT CANNOT WORK IS NOT DRAWN. Drafts and artifacts are absent, not
 * greyed: both are reachable only through the CALLER's own session, and from the
 * phone's proxy identity they would answer emptily rather than refuse. A live
 * row that silently does nothing is worse than no row, and "not permitted" would
 * be a lie — the user IS permitted; there is simply nothing to call. They appear
 * by themselves the day a session-scoped surface exists.
 *
 * The sheet is hand-drawn rather than a ModalBottomSheet: Material's sheet tints
 * its surface, and this design's elevation is a hairline on true black.
 */
@Composable
fun SessionSheet(
    sessionName: String,
    capabilities: Capabilities,
    onAction: (SessionAction) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Close is the only destructive action, so it alone confirms — and it names
    // the session, because "are you sure?" answers nothing. Nothing else
    // confirms: a prompt on every action trains people to tap through the one
    // that matters.
    var confirming by remember { mutableStateOf(false) }

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
                            if (action == SessionAction.Close) confirming = true else onAction(action)
                        },
                    )
                }
            }
        }
    }
}

/**
 * The sheet's order, top to bottom: what you look at, what you tidy, what you
 * create, what you destroy. Destructive last, furthest from the reading position.
 */
private val SHEET_ACTIONS = listOf(
    SessionAction.Snapshot,
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

/** The label colour: dim when unavailable, danger for the one that destroys. */
private fun SessionAction.labelColor(permitted: Boolean): Color = when {
    !permitted -> HelmColors.Faint
    this == SessionAction.Close -> HelmColors.Danger
    else -> HelmColors.Txt
}

private val SessionAction.labelRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_action_snapshot
        SessionAction.Compact -> R.string.control_action_compact
        SessionAction.Spawn -> R.string.control_action_spawn
        SessionAction.Close -> R.string.control_action_close
    }

private val SessionAction.glyphRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_glyph_snapshot
        SessionAction.Compact -> R.string.control_glyph_compact
        SessionAction.Spawn -> R.string.control_glyph_spawn
        SessionAction.Close -> R.string.control_glyph_close
    }

/** Dark enough to push the thread behind it back, never opaque. */
private const val SCRIM_ALPHA = 0.72f

/** The mockup greys a forbidden row to 30%, on top of the Faint colour. */
private const val FORBIDDEN_ALPHA = 0.3f
private const val GRAB_THICKNESS = 4
private val GRAB_WIDTH = HelmSize.TouchTarget
