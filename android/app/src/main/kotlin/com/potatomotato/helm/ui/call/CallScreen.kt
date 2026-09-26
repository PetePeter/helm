package com.potatomotato.helm.ui.call

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.voice.AudioRoute
import com.potatomotato.helm.voice.CallPhase
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.voice.VoicePermission

/**
 * The call screen: who, what the call is doing, the conversation as it
 * happens, and the three things a caller touches — route, mute, hang up.
 *
 * The transcript IS the target's chat thread, not a copy: the call and the
 * chat can never disagree about what was said. Everything else is read off
 * [VoiceCallService.call]; this screen holds no call state of its own, so the
 * phone can sleep and the call carries on. Leaving the screen hangs up.
 */
@Composable
fun CallScreen(
    targetId: String,
    targetName: String,
    call: VoiceCallService.Call?,
    thread: List<ChatMessage>,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var denied by remember { mutableStateOf(false) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) VoiceCallService.start(context, targetId) else denied = true
    }

    // Arriving here IS dialling. A call already live (back from the notification)
    // is joined, never re-dialled.
    LaunchedEffect(targetId) {
        if (call != null) return@LaunchedEffect
        if (VoicePermission.granted(context)) {
            VoiceCallService.start(context, targetId)
        } else {
            request.launch(VoicePermission.required.first())
        }
    }

    // Leaving the screen (Back, or the composition going away) IS hanging up:
    // a call must never keep the mic open behind the user's back. A rotation
    // is not leaving — the recreated screen rejoins the live call.
    DisposableEffect(Unit) {
        onDispose {
            if ((context as? Activity)?.isChangingConfigurations != true) VoiceCallService.hangUp(context)
        }
    }

    val listState = rememberLazyListState()
    LaunchedEffect(thread.size) { if (thread.isNotEmpty()) listState.animateScrollToItem(thread.size - 1) }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Column(modifier = Modifier.padding(HelmSpacing.Gutter)) {
            Text(
                text = targetName,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(
                    when {
                        denied -> R.string.call_permission
                        call == null -> R.string.call_phase_idle
                        call.state.muted && call.state.phase == CallPhase.Listening -> R.string.call_muted
                        else -> call.state.phase.labelRes
                    },
                ),
                color = if (call?.state?.phase == CallPhase.Listening) HelmColors.Accent else HelmColors.Dim,
                style = MaterialTheme.typography.labelLarge,
            )
            call?.state?.heard?.takeIf { it.isNotBlank() }?.let {
                Text(text = it, color = HelmColors.Dim, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Hairline()

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            items(thread, key = { it.key }) { message ->
                Text(
                    text = message.text,
                    color = if (message.fromPhone) HelmColors.Dim else HelmColors.Txt,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter),
                )
            }
        }

        Hairline()
        if (call != null && call.state.phase != CallPhase.Ended) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(HelmSpacing.Md),
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
                modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Md),
                horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                Chip(
                    text = stringResource(if (call.state.muted) R.string.call_unmute else R.string.call_mute),
                    selected = call.state.muted,
                    onClick = { VoiceCallService.setMuted(context, !call.state.muted) },
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = stringResource(R.string.call_hang_up),
                    color = HelmColors.Danger,
                    style = MaterialTheme.typography.labelLarge,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(HelmRadius.Md))
                        .clickable { VoiceCallService.hangUp(context) }
                        .padding(vertical = HelmSpacing.Md),
                )
            }
        }
        GhostButton(
            text = stringResource(R.string.call_back),
            onClick = onBack,
            modifier = Modifier.padding(HelmSpacing.Md),
        )
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
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(if (selected) HelmColors.Accent else HelmColors.Surface2)
            .clickable(onClick = onClick)
            .padding(vertical = HelmSpacing.Sm, horizontal = HelmSpacing.Md),
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
    }
