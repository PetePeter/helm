package com.potatomotato.helm

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.ble.BlePermissions
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.link.PairingState
import com.potatomotato.helm.ui.pairing.PairingScreen

/**
 * Placeholder shell. The real navigation and screens arrive with the design
 * system (P-0740); what is here is the permission gate and the link status,
 * because a denied permission must explain itself rather than crash.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { HelmRoot() }
    }
}

private val Accent = Color(0xFFCCFF00)

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
            .background(Color.Black)
            .padding(24.dp),
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

                is PairingState.Failed -> Text(text = pairing.message, color = Color.White)
                is PairingState.Handshaking -> Text(
                    text = stringResource(R.string.pairing_handshaking),
                    color = Accent,
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

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text = stringResource(R.string.app_name), color = Accent)
        Text(text = stringResource(label), color = Color.White)
    }
}

@Composable
private fun PermissionRationale(onGrant: () -> Unit, onOpenSettings: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(text = stringResource(R.string.permission_title), color = Accent)
        Text(text = stringResource(R.string.permission_body), color = Color.White)
        Button(
            onClick = onGrant,
            colors = ButtonDefaults.buttonColors(
                containerColor = Accent,
                contentColor = Color(0xFF0D1200),
            ),
        ) {
            Text(text = stringResource(R.string.permission_grant))
        }
        Button(
            onClick = onOpenSettings,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFF1A1A1A),
                contentColor = Color.White,
            ),
        ) {
            Text(text = stringResource(R.string.permission_settings))
        }
    }
}
