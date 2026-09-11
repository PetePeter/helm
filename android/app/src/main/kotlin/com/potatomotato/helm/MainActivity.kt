package com.potatomotato.helm

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.ble.BlePermissions
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.link.PairingState
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.ui.components.StateDot
import com.potatomotato.helm.ui.pairing.PairingScreen
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmTheme

/**
 * Shell. The session list, chat and control screens arrive with P-0743 onward;
 * what is here is the permission gate and the link status, because a denied
 * permission must explain itself rather than crash.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { HelmTheme { HelmRoot() } }
    }
}

@Composable
private fun HelmRoot() {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(BlePermissions.allGranted(context)) }

    val request = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        granted = BlePermissions.allGranted(context)
        if (granted) HelmLinkService.start(context)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(HelmSpacing.Xl),
        contentAlignment = Alignment.Center,
    ) {
        if (granted) {
            LaunchedEffect(Unit) { HelmLinkService.start(context) }
            when (val pairing = HelmPairing.state.collectAsState().value) {
                // The SAS is the only moment that must interrupt whatever else is
                // on screen: an unanswered prompt is a link that never completes.
                is PairingState.Comparing -> PairingScreen(
                    desktopId = pairing.desktopId,
                    sas = pairing.sas,
                    onMatch = { HelmPairing.confirm(true) },
                    onReject = { HelmPairing.confirm(false) },
                )

                is PairingState.Failed -> Text(
                    text = pairing.message,
                    color = HelmColors.Danger,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )

                is PairingState.Handshaking -> Text(
                    text = stringResource(R.string.pairing_handshaking),
                    color = HelmColors.Accent,
                    style = MaterialTheme.typography.bodyLarge,
                )

                else -> LinkStatus()
            }
        } else {
            PermissionRationale(
                onGrant = { request.launch(BlePermissions.missing(context).toTypedArray()) },
                onOpenSettings = {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", context.packageName, null),
                        ),
                    )
                },
            )
        }
    }
}

@Composable
private fun LinkStatus() {
    val state by HelmLink.state.collectAsState()
    val label = when (state) {
        LinkState.Linked -> R.string.link_state_linked
        LinkState.Connecting -> R.string.link_state_connecting
        LinkState.Advertising -> R.string.link_state_advertising
        LinkState.Disconnected -> R.string.link_state_disconnected
    }

    // The link dot borrows the session state palette on purpose: one glowing
    // green dot means "live" everywhere in the app, chrome or session.
    val dot = when (state) {
        LinkState.Linked -> SessionState.Active
        LinkState.Connecting, LinkState.Advertising -> SessionState.Waiting
        LinkState.Disconnected -> SessionState.Idle
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        Text(
            text = stringResource(R.string.app_name),
            color = HelmColors.Accent,
            style = MaterialTheme.typography.titleLarge,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
        ) {
            StateDot(state = dot, size = HelmSize.DotSmall)
            Text(
                text = stringResource(label),
                color = HelmColors.Dim,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun PermissionRationale(onGrant: () -> Unit, onOpenSettings: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
    ) {
        Text(
            text = stringResource(R.string.permission_title),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.permission_body),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        // Primary action sits lowest and reads accent — one-handed reach.
        PrimaryButton(
            text = stringResource(R.string.permission_grant),
            onClick = onGrant,
        )
        GhostButton(
            text = stringResource(R.string.permission_settings),
            onClick = onOpenSettings,
        )
    }
}
