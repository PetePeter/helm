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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

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

/** Dot plus label, for an app bar or a status line. */
@Composable
fun LinkBadge(state: LinkState, modifier: Modifier = Modifier) {
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
    onBack: (() -> Unit)? = null,
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
            Text(
                text = "‹",
                color = HelmColors.Accent,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier
                    .size(HelmSize.TouchTarget)
                    .clickable(onClick = onBack)
                    .padding(horizontal = HelmSpacing.Md),
            )
        }
        Text(
            text = title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 1,
            // A long session name truncates; wrapping would push the link badge
            // off the bar, which is the one thing that must always be visible.
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Row(
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.End,
        ) {
            LinkBadge(linkState)
        }
    }
    Hairline()
}

/** The one unit of elevation this design system has. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(HelmSize.Hairline)
            .background(HelmColors.Line),
    )
}
