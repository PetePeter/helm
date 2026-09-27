package com.potatomotato.helm

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
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
import com.potatomotato.helm.notify.IncomingRing
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.notify.PendingOpen
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.PermissionRationale
import com.potatomotato.helm.ui.components.PrimaryButton
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

    /**
     * Only an answered ring earns the lock-screen pass, and only while visible:
     * once the activity is left, Helm is back behind the keyguard like any app.
     */
    override fun onStop() {
        super.onStop()
        showOverLockScreen(false)
    }

    private fun showOverLockScreen(show: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(show)
            setTurnScreenOn(show)
        } else {
            // API 26 only has the (deprecated since 27) window flags.
            @Suppress("DEPRECATION")
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (show) window.addFlags(flags) else window.clearFlags(flags)
        }
    }

    private fun takeNotificationTap(intent: Intent?) {
        // Answering the operator's ring: the activity is visible, which is what
        // lets the microphone service start. Without the mic grant the thread
        // opens instead, where the call button asks for it.
        intent?.getStringExtra(IncomingRing.EXTRA_ACCEPT_SESSION)?.let { sessionId ->
            // This activity is exported: without the ring's live ticket the
            // "answer" came from elsewhere, and it only opens the thread.
            if (!IncomingRing.tickets.redeem(sessionId, intent.getStringExtra(IncomingRing.EXTRA_ACCEPT_TICKET))) {
                PendingOpen.request(sessionId)
                return
            }
            IncomingRing.dismiss(this)
            // Answered on a locked phone: the call must start over the lock
            // screen, like a phone call does, not wait for an unlock.
            showOverLockScreen(true)
            val canTalk = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (canTalk) VoiceCallService.start(this, sessionId)
            PendingOpen.request(sessionId)
            return
        }
        PendingOpen.request(
            intent?.getStringExtra(AndroidNotifications.EXTRA_SESSION_ID),
            intent?.getBooleanExtra(AndroidNotifications.EXTRA_ARTIFACTS, false) == true,
        )
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
                onCancel = { HelmPairing.cancel() },
            )
        }

        // A failure the user cannot leave is a failure they have to force-quit
        // out of, so the message always comes with a way back.
        is PairingState.Failed -> Interstitial {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
            ) {
                Text(
                    text = stringResource(R.string.pairing_failed_title),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.labelSmall,
                )
                Text(
                    text = pairing.message,
                    color = HelmColors.Danger,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )
                PrimaryButton(
                    text = stringResource(R.string.pairing_retry),
                    onClick = { HelmPairing.dismissFailure() },
                )
            }
        }

        // The one screen with no deadline behind it: the desktop drives the
        // handshake, and if it never answers this used to be a line of static
        // text with no spinner and no way out — indistinguishable from a hang.
        is PairingState.Handshaking -> Interstitial {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
            ) {
                CircularProgressIndicator(color = HelmColors.Accent)
                Text(
                    text = stringResource(R.string.pairing_handshaking),
                    color = HelmColors.Accent,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(
                    text = stringResource(R.string.pairing_handshaking_detail),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
                GhostButton(
                    text = stringResource(R.string.pairing_cancel),
                    onClick = { HelmPairing.cancel() },
                )
            }
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

