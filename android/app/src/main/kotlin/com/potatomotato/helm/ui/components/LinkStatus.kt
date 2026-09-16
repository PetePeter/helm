package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType

/**
 * The link, said once.
 *
 * Every screen carries it because the app is USELESS without a link and must
 * never leave the user guessing whether what they are reading is live. One
 * definition, so the wording and the dot cannot drift between screens.
 */

/** The user-facing name for a link state. */
val LinkState.labelRes: Int
    get() = when (this) {
        LinkState.Linked -> R.string.link_state_linked
        LinkState.Connecting -> R.string.link_state_connecting
        LinkState.Advertising -> R.string.link_state_advertising
        LinkState.Disconnected -> R.string.link_state_disconnected
    }

/**
 * The link borrows the session state palette on purpose: one glowing green dot
 * means "live" everywhere in the app, chrome or session.
 */
val LinkState.dot: SessionState
    get() = when (this) {
        LinkState.Linked -> SessionState.Active
        LinkState.Connecting, LinkState.Advertising -> SessionState.Waiting
        LinkState.Disconnected -> SessionState.Idle
    }

/**
 * Dot plus label, for an app bar or a status line.
 *
 * [rank] names the transport carrying the link — see [transportLabelRes], which
 * owns the decision of when naming one would be a guess. It defaults to null so
 * a caller with nothing truthful to say says nothing, rather than being forced
 * to invent a value.
 */
@Composable
fun LinkBadge(state: LinkState, modifier: Modifier = Modifier, rank: Int? = null) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        StateDot(state = state.dot, size = HelmSize.DotSmall)
        Text(
            text = stringResource(state.labelRes),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodySmall,
        )
        // Quieter than the state itself: "are we live" is the question the badge
        // answers, and "over what" is the footnote to it.
        transportLabelRes(state, rank)?.let { transport ->
            Text(
                text = "${stringResource(R.string.link_transport_separator)} ${stringResource(transport)}",
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/**
 * The app bar both screens share: an optional back affordance, a title, and the
 * link badge that is never allowed to be absent.
 *
 * Elevation is the hairline underneath, never a lighter fill — see HelmColors.
 */
@Composable
fun HelmAppBar(
    title: String,
    linkState: LinkState,
    modifier: Modifier = Modifier,
    /**
     * The owning transport's rank, so the badge can name it.
     *
     * Read from [HelmLink] by default rather than threaded down from each
     * screen. Ten call sites pass a link state they got from the same object a
     * moment earlier, and a badge that names the transport on only the screens
     * someone remembered to update is worse than one that never does — the
     * point of this file is that the link is said ONCE, the same way everywhere.
     */
    linkRank: Int? = HelmLink.owner.collectAsState().value,
    /**
     * What the title is about, said quietly after it — the main screen names
     * the desktop and then where you are: "Helm  SESSIONS". Screens whose title
     * already says it (a session name, "Snapshot") leave this out.
     */
    contextLabel: String? = null,
    onBack: (() -> Unit)? = null,
    /**
     * Makes the link badge itself the way in to the desktops list.
     *
     * The badge is already the thing the user looks at to ask "what am I
     * connected to"; the paired-desktops screen is the longer answer to that
     * same question, so it costs no new chrome on an already-full bar.
     */
    onLinkClick: (() -> Unit)? = null,
    /**
     * The control overflow, when a screen has one. It sits AFTER the link badge
     * rather than replacing it: the mockup draws the badge and the ⋮ in the same
     * corner, and of the two the badge is the one that may never be absent.
     *
     * [overflowGlyphRes] because the affordance is not always an overflow menu:
     * the snapshot screen's corner action is a refresh, and drawing ⋮ there asks
     * for a menu that does not exist.
     */
    onOverflow: (() -> Unit)? = null,
    overflowGlyphRes: Int = R.string.control_overflow_glyph,
    /**
     * Export the log to Downloads. It sits immediately after the link badge
     * because the two are read together: what the user reports is almost always
     * "it says Linked but nothing arrives", and the evidence for that sentence
     * is one tap away from the words that prompted it.
     */
    onExportLogs: (() -> Unit)? = null,
    /**
     * The master notification switch, when a screen offers it — only the session
     * list does, because that is the screen the user is on when the buzzing
     * becomes too much.
     *
     * A bell that changes glyph rather than a Material Switch: the bar is a row
     * of equal-weight glyph actions, and a switch would be the only control in
     * the app that renders its own state as a track. [notificationsEnabled] is
     * the state it draws, hoisted like every other piece of state here.
     */
    notificationsEnabled: Boolean = true,
    onToggleNotifications: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        if (onBack != null) {
            // The glyph lives in a centred touch-target box: sizing the Text
            // itself left it top-aligned in the bar, hanging above the title.
            Box(
                modifier = Modifier
                    .size(HelmSize.TouchTarget)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "‹",
                    color = HelmColors.Accent,
                    // ‹ sits small in its em box; at title size it reads as
                    // punctuation, not a button. See HelmType.BackGlyph.
                    style = HelmType.BackGlyph,
                )
            }
        }
        // Title + context share ONE weighted block so the context eyebrow hugs
        // the title while the badge and overflow stay pinned to the trailing
        // edge. A title that also carried a weight fought the block for the
        // leftover space and pulled the whole trailing cluster short of the
        // edge — measured ~35% of the bar on a real tablet.
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Text(
                text = title,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                // A long session name truncates; wrapping would push the link
                // badge off the bar, which is the one thing that must always
                // be visible.
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (contextLabel != null) {
                Text(
                    text = contextLabel.uppercase(),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    modifier = Modifier.padding(start = HelmSpacing.Xs),
                )
            }
        }
        LinkBadge(
            state = linkState,
            rank = linkRank,
            modifier = if (onLinkClick == null) {
                Modifier
            } else {
                Modifier
                    .clickable(onClick = onLinkClick)
                    // The badge is short; without padding its touch target is
                    // thinner than a finger.
                    .padding(vertical = HelmSpacing.Sm, horizontal = HelmSpacing.Xs)
            },
        )
        if (onToggleNotifications != null) {
            Box(
                modifier = Modifier
                    .size(HelmSize.TouchTarget)
                    .clickable(onClick = onToggleNotifications),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(
                        if (notificationsEnabled) R.string.notifications_glyph_on
                        else R.string.notifications_glyph_off,
                    ),
                    // Accent when live, Faint when silenced: the state must be
                    // readable at a glance without counting bell strokes.
                    color = if (notificationsEnabled) HelmColors.Accent else HelmColors.Faint,
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
        if (onExportLogs != null) {
            Box(
                modifier = Modifier
                    .size(HelmSize.TouchTarget)
                    .clickable(onClick = onExportLogs),
                contentAlignment = Alignment.Center,
            ) {
                // A real diagnostic icon, not a glyph in a Text. The earlier
                // down-arrow read as navigation rather than exporting the log.
                Icon(
                    painter = painterResource(R.drawable.ic_bug_report),
                    contentDescription = stringResource(R.string.logs_export_description),
                    tint = HelmColors.Dim,
                    modifier = Modifier.size(HelmSize.Icon),
                )
            }
        }
        if (onOverflow != null) {
            // Same centred touch-target box as the back affordance: sizing
            // the glyph Text directly left blank space after it, so the
            // badge and the glyph hung short of the trailing edge.
            Box(
                modifier = Modifier
                    .size(HelmSize.TouchTarget)
                    .clickable(onClick = onOverflow),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(overflowGlyphRes),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
    }
    Hairline()
}

/**
 * The one unit of elevation this design system has.
 *
 * [color] defaults to [HelmColors.Line]; list rows pass [HelmColors.Separator]
 * to divide themselves more quietly than components are edged.
 */
@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = HelmColors.Line) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(HelmSize.Hairline)
            .background(color),
    )
}
