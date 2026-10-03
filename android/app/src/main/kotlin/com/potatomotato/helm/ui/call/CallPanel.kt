package com.potatomotato.helm.ui.call

import android.widget.Toast
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.voice.AudioRoute
import com.potatomotato.helm.voice.CallPhase
import com.potatomotato.helm.voice.MicMode
import com.potatomotato.helm.voice.RedKeyPttAccessibilityService
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.voice.VoicePermission

/**
 * A live call, drawn where the chat composer normally sits.
 *
 * The call is a mode of the chat, not a screen of its own: the thread above
 * already IS the transcript (the call sends and speaks through it), so all a
 * call adds is what it is doing and the three things a caller touches — route,
 * mute, hang up. Everything is read off [VoiceCallService.call]; the panel holds
 * no state, so leaving the chat (or the screen sleeping) leaves the call alone,
 * the way a phone app does. The notification can always hang up.
 */
@Composable
fun CallPanel(call: VoiceCallService.Call, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Hairline()
        Column(modifier = Modifier.padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm)) {
            Text(
                text = stringResource(
                    if (call.state.muted && call.state.phase == CallPhase.Listening) R.string.call_muted
                    else call.state.phase.labelRes,
                ),
                color = if (call.state.phase == CallPhase.Listening) HelmColors.Accent else HelmColors.Dim,
                style = MaterialTheme.typography.labelLarge,
            )
            call.state.heard.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Md),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            for (route in AudioRoute.entries.filter { it in call.routes }) {
                Chip(
                    text = stringResource(route.labelRes),
                    selected = route == call.route,
                    onClick = { VoiceCallService.setRoute(context, route) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Md),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Chip(
                text = stringResource(
                    when (call.state.micMode) {
                        MicMode.Open -> R.string.call_mic_open
                        MicMode.Muted -> R.string.call_mic_muted
                        MicMode.PushToTalk -> if (call.state.pttHeld) R.string.call_ptt_talking else R.string.call_ptt_ready
                    },
                ),
                selected = call.state.micMode != MicMode.Open,
                onClick = {
                    val next = when (call.state.micMode) {
                        MicMode.Open -> MicMode.Muted
                        MicMode.Muted -> MicMode.PushToTalk
                        MicMode.PushToTalk -> MicMode.Open
                    }
                    VoiceCallService.setMicMode(context, next)
                    if (next == MicMode.PushToTalk && !RedKeyPttAccessibilityService.connected) {
                        Toast.makeText(context, R.string.call_ptt_enable_accessibility, Toast.LENGTH_LONG).show()
                        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    }
                },
                modifier = Modifier.weight(1f),
            )
            Text(
                text = stringResource(R.string.call_hang_up),
                color = HelmColors.OnAccent,
                style = MaterialTheme.typography.labelLarge,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(HelmRadius.Pill))
                    .background(HelmColors.Danger)
                    .heightIn(min = 64.dp)
                    .clickable { VoiceCallService.hangUp(context) }
                    .padding(vertical = 20.dp),
            )
        }
    }
}

/**
 * Dial [targetId], asking for the microphone first when needed. One entry
 * point for every call button, so the permission path is written once.
 */
@Composable
fun rememberDialer(): (targetId: String) -> Unit {
    val context = LocalContext.current
    val pending = remember { arrayOfNulls<String>(1) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        val target = pending[0]
        pending[0] = null
        when {
            target == null -> Unit
            allowed -> VoiceCallService.start(context, target)
            else -> Toast.makeText(context, R.string.call_permission, Toast.LENGTH_LONG).show()
        }
    }
    return remember(context) {
        { target ->
            if (VoicePermission.granted(context)) {
                VoiceCallService.start(context, target)
            } else {
                pending[0] = target
                request.launch(VoicePermission.required.first())
            }
        }
    }
}

@Composable
private fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = if (selected) HelmColors.OnAccent else HelmColors.Txt,
        style = MaterialTheme.typography.labelLarge,
        maxLines = 1,
        textAlign = TextAlign.Center,
        modifier = modifier
            .heightIn(min = 64.dp)
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(if (selected) HelmColors.Accent else HelmColors.Surface2)
            .clickable(onClick = onClick)
            .padding(vertical = 20.dp, horizontal = HelmSpacing.Md),
    )
}

private val CallPhase.labelRes: Int
    get() = when (this) {
        CallPhase.Idle -> R.string.call_phase_idle
        CallPhase.Listening -> R.string.call_phase_listening
        CallPhase.Sending -> R.string.call_phase_sending
        CallPhase.Speaking -> R.string.call_phase_speaking
        CallPhase.Ended -> R.string.call_phase_ended
    }

private val AudioRoute.labelRes: Int
    get() = when (this) {
        AudioRoute.Earpiece -> R.string.call_route_earpiece
        AudioRoute.Speaker -> R.string.call_route_speaker
        AudioRoute.Bluetooth -> R.string.call_route_bluetooth
        AudioRoute.WiredHeadset -> R.string.call_route_wired_headset
    }
