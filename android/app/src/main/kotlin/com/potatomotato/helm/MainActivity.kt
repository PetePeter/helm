package com.potatomotato.helm

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.ble.BlePermissions
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.link.PairingState
import com.potatomotato.helm.notify.AndroidNotifications
import com.potatomotato.helm.notify.PendingOpen
import com.potatomotato.helm.ui.components.PermissionRationale
import com.potatomotato.helm.ui.HelmHome
import com.potatomotato.helm.ui.pairing.PairingScreen
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmTheme

/**
 * Shell. It owns only what must happen before there is anything to show: the
 * permission gate, which explains itself rather than crashing, and the SAS
 * prompt, which has to interrupt. Everything past that is [HelmHome].
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Declared, not inherited. API 35 forces edge-to-edge on regardless of
        // this call, so saying it out loud is the difference between a layout
        // contract and a silent platform default that a targetSdk bump changes
        // underneath us. HelmTheme consumes the insets it opens up.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A cold start from a notification tap: the extra is on the launch intent
        // and there is no composition yet to hand it to, so it is parked.
        takeNotificationTap(intent)
        setContent { HelmTheme { HelmRoot() } }
    }

    /** A warm tap — the activity is already up, so the intent arrives here instead. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeNotificationTap(intent)
    }

    private fun takeNotificationTap(intent: Intent?) {
        PendingOpen.request(intent?.getStringExtra(AndroidNotifications.EXTRA_SESSION_ID))
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

    if (!granted) {
        Interstitial {
            PermissionRationale(
                title = stringResource(R.string.permission_title),
                body = stringResource(R.string.permission_body),
                onGrant = { request.launch(BlePermissions.missing(context).toTypedArray()) },
            )
        }
        return
    }

    LaunchedEffect(Unit) { HelmLinkService.start(context) }

    when (val pairing = HelmPairing.state.collectAsState().value) {
        // The SAS is the only moment that must interrupt whatever else is on
        // screen: an unanswered prompt is a link that never completes.
        is PairingState.Comparing -> Interstitial {
            PairingScreen(
                desktopId = pairing.desktopId,
                sas = pairing.sas,
                onMatch = { HelmPairing.confirm(true) },
                onReject = { HelmPairing.confirm(false) },
            )
        }

        is PairingState.Failed -> Interstitial {
            Text(
                text = pairing.message,
                color = HelmColors.Danger,
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
            )
        }

        is PairingState.Handshaking -> Interstitial {
            Text(
                text = stringResource(R.string.pairing_handshaking),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.bodyLarge,
            )
        }

        // Idle and Linked both land on the session list: it carries the link
        // state itself, so "no desktop yet" is a state of the real screen rather
        // than a separate placeholder the user has to wait out.
        else -> HelmHome()
    }
}

/** A centred, gutter-padded page — the shape every non-list screen wants. */
@Composable
private fun Interstitial(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(HelmSpacing.Xl),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

