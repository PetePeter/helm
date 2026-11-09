package com.potatomotato.helm.ui.control

import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.SCRIM_ALPHA
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
    keepWarm: Boolean,
    frozen: Boolean,
    capabilities: Capabilities,
    onAction: (SessionAction) -> Unit,
    onRename: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    clis: List<HelmCli> = emptyList(),
    onSwitchCli: (String) -> Unit = {},
) {
    var selectedCategory by remember { mutableStateOf<SessionActionCategory?>(null) }
    val actionModel = remember(keepWarm, frozen, capabilities) { sessionActions(keepWarm, frozen, capabilities) }
    val dialogState = rememberSessionActionDialogState()
    val selectedGroup = actionModel.phoneGroups.firstOrNull { it.category == selectedCategory }

    BackHandler(enabled = selectedCategory != null) { selectedCategory = null }

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

            val confirmed = dialogState.confirmation
            if (confirmed != null) {
                SessionActionConfirmation(
                    entry = confirmed,
                    sessionName = sessionName,
                    onConfirm = {
                        dialogState.confirm()?.let(onAction)
                    },
                    onCancel = dialogState::cancelConfirmation,
                )
            } else if (selectedGroup != null) {
                Text(
                    text = "‹ ${stringResource(selectedGroup.category.titleRes)}",
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { selectedCategory = null }
                        .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
                )
                Hairline()
                for (entry in selectedGroup.actions) {
                    ActionRow(
                        entry = entry,
                        onClick = { dialogState.select(entry)?.let(onAction) },
                    )
                }
            } else {
                for (group in actionModel.phoneGroups) {
                    CategoryRow(
                        title = stringResource(group.category.titleRes),
                        count = group.actions.size,
                        onClick = { selectedCategory = group.category },
                    )
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
        )
    }
}

@Composable
private fun CategoryRow(title: String, count: Int, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = HelmColors.Txt, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Text(count.toString(), color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
        Text("  ›", color = HelmColors.Dim, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ActionRow(
    entry: SessionActionEntry,
    onClick: () -> Unit,
) {
    val permitted = entry.permitted

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
                text = stringResource(entry.glyphRes),
                color = entry.action.labelColor(permitted),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        Text(
            text = stringResource(entry.labelRes),
            color = entry.action.labelColor(permitted),
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
                    if (entry.capabilityAnswered) R.string.control_not_permitted else R.string.control_asking,
                ),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
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

/** The mockup greys a forbidden row to 30%, on top of the Faint colour. */
private const val FORBIDDEN_ALPHA = 0.3f
private const val GRAB_THICKNESS = 4
private val GRAB_WIDTH = HelmSize.TouchTarget
