package com.potatomotato.helm.ui.pairing

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing
import kotlinx.coroutines.delay

/**
 * What "Pair a desktop" leads to now instead of nothing.
 *
 * The phone is the BLE peripheral: it can only advertise and wait, it cannot
 * reach out to a desktop. Every past complaint about this button ("I pressed
 * it and nothing happened") was really a complaint about that fact having no
 * screen of its own — the tap re-advertised silently and the user had no way
 * to tell a hang from a link that was one desktop command away from starting.
 * This screen says the true thing: you are ready, waiting is expected, and the
 * next move belongs to the desktop.
 *
 * It is superseded automatically the moment a desktop actually connects —
 * MainActivity's [com.potatomotato.helm.link.PairingState.Handshaking] and
 * [com.potatomotato.helm.link.PairingState.Comparing] interstitials sit above
 * this screen in HelmHome's routing, so this waiting state simply stops being
 * drawn rather than needing to hand off to them.
 */
@Composable
fun AwaitingDesktopScreen(
    linkState: LinkState,
    onReadvertise: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(title = stringResource(R.string.pairing_wait_title), linkState = linkState, onBack = onBack)
        Box(
            modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl),
            contentAlignment = Alignment.Center,
        ) {
            AwaitingDesktopBody(linkState = linkState, onReadvertise = onReadvertise, onCancel = onBack)
        }
    }
}

@Composable
private fun AwaitingDesktopBody(
    linkState: LinkState,
    onReadvertise: () -> Unit,
    onCancel: () -> Unit,
) {
    var elapsedSeconds by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            elapsedSeconds++
        }
    }
    val stillWaiting = elapsedSeconds >= STILL_WAITING_THRESHOLD_S

    // A poke and its acknowledgement are two different pieces of state on
    // purpose: the button always re-advertises (idempotent, harmless), but the
    // "just did that" line is its own short-lived flag so mashing the button
    // reads as "acknowledged, acknowledged, acknowledged" rather than one
    // acknowledgement quietly outliving the tap that caused it.
    var pokeCount by remember { mutableIntStateOf(0) }
    var showPoked by remember { mutableStateOf(false) }
    LaunchedEffect(pokeCount) {
        if (pokeCount == 0) return@LaunchedEffect
        showPoked = true
        delay(POKE_ACK_MS)
        showPoked = false
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
    ) {
        // The app bar above already carries the title and the live LinkBadge;
        // repeating either here would be the same fact said twice on one screen.
        CircularProgressIndicator(color = HelmColors.Accent)

        // The one instruction that used to live nowhere in the app: pairing
        // does not progress from this side, so the user needs to be told,
        // explicitly, to go act on the desktop.
        Text(
            text = stringResource(R.string.pairing_wait_instruction),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        Text(
            text = stringResource(R.string.pairing_wait_elapsed, formatElapsed(elapsedSeconds)),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.bodySmall,
        )

        AnimatedVisibility(visible = stillWaiting) {
            Text(
                text = stringResource(R.string.pairing_wait_still_waiting),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
        }

        AnimatedVisibility(visible = showPoked) {
            Text(
                text = stringResource(R.string.pairing_wait_readvertised),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Column(
            modifier = Modifier,
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            GhostButton(
                text = stringResource(R.string.pairing_wait_readvertise),
                onClick = {
                    pokeCount++
                    onReadvertise()
                },
            )
            GhostButton(text = stringResource(R.string.pairing_cancel), onClick = onCancel)
        }
    }
}

/** Past this, "still working" needs to be said out loud rather than implied by a spinner. */
private const val STILL_WAITING_THRESHOLD_S = 30

/** Long enough to read, short enough that a second tap does not look stuck on. */
private const val POKE_ACK_MS = 2_000L
