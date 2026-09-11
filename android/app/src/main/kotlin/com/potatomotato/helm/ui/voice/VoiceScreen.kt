package com.potatomotato.helm.ui.voice

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.PermissionRationale
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.voice.AndroidSpeechEngine
import com.potatomotato.helm.voice.SpeechController
import com.potatomotato.helm.voice.SpeechError
import com.potatomotato.helm.voice.VoicePermission
import com.potatomotato.helm.voice.VoicePhase
import com.potatomotato.helm.voice.VoiceState
import kotlin.math.sin

/**
 * Mockup screen 3 — speak, watch the words land, fix them, send.
 *
 * The screen never fires on what it thought it heard. Recognition produces text
 * in an editable field and nothing leaves until the user taps Send, at which
 * point they are put back in the thread the words went to so the message is
 * visible as it delivers rather than vanishing into a list.
 */
@Composable
fun VoiceScreen(
    sessionName: String,
    linkState: LinkState,
    onCancel: () -> Unit,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val controller = remember { SpeechController(AndroidSpeechEngine(context)) }
    val state by controller.state.collectAsState()

    var granted by remember { mutableStateOf(VoicePermission.granted(context)) }
    val request = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { allowed ->
        granted = allowed
        // Starting here as well as in the effect below matters: when the
        // recogniser reported a refusal the system check may still say granted,
        // so `granted` never changes and the effect never re-fires. start() is
        // idempotent while listening, so the overlap is free.
        if (allowed) controller.start()
    }

    // The user tapped a mic to get here, so listening is what they asked for —
    // making them tap a second mic would be the screen asking them to repeat
    // themselves before they have said anything.
    LaunchedEffect(granted) {
        if (granted) controller.start()
    }

    // Leaving the screen — by the ✕, by the back gesture, or by sending — must
    // not leave the microphone open behind it.
    DisposableEffect(controller) {
        onDispose { controller.release() }
    }
    BackHandler { onCancel() }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = stringResource(R.string.voice_title),
            linkState = linkState,
            onBack = onCancel,
        )
        Destination(sessionName)

        // The recogniser can report a refusal even when the check above passed —
        // a permission revoked while the screen was open, for instance. Either
        // way the answer is the same explanation and the same route out.
        if (!granted || state.error == SpeechError.PermissionDenied) {
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth().padding(HelmSpacing.Xl),
                contentAlignment = Alignment.Center,
            ) {
                PermissionRationale(
                    title = stringResource(R.string.voice_permission_title),
                    body = stringResource(R.string.voice_permission_body),
                    onGrant = { request.launch(VoicePermission.required.first()) },
                )
            }
            return@Column
        }

        Column(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(HelmSpacing.Xl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xl, Alignment.CenterVertically),
        ) {
            Text(
                text = stringResource(state.statusRes),
                color = if (state.phase == VoicePhase.Failed) HelmColors.Danger else HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.Center,
            )

            // Offering a retry that cannot succeed — no recogniser installed at
            // all — is worse than offering nothing: the user taps it repeatedly
            // and learns the app is broken rather than the phone is missing a
            // component. The status line already says which it is.
            if (state.error?.retryable != false) {
                MicButton(
                    listening = state.phase == VoicePhase.Listening,
                    onClick = {
                        if (state.phase == VoicePhase.Listening) controller.stop() else controller.start()
                    },
                )
            }

            Waveform(level = state.level, listening = state.phase == VoicePhase.Listening)

            Transcript(
                transcript = state.transcript,
                editable = state.phase != VoicePhase.Listening,
                onEdit = controller::edit,
            )
        }

        Actions(
            canSend = state.transcript.isNotBlank(),
            onCancel = onCancel,
            onSend = { onSend(state.transcript.trim()) },
        )
    }
}

/** Where the words are going. The mic is useless without it on screen. */
@Composable
private fun Destination(sessionName: String) {
    Text(
        text = stringResource(R.string.voice_destination, sessionName),
        color = HelmColors.Dim,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        textAlign = TextAlign.Center,
    )
}

/**
 * The one control. Tapping it while listening finishes the utterance rather than
 * abandoning it — the user has said their piece and wants the final result.
 */
@Composable
private fun MicButton(listening: Boolean, onClick: () -> Unit) {
    // Dimmed when not listening so "the microphone is open" is visible from
    // across a room, without animating anything while it is closed.
    val alpha by animateFloatAsState(
        targetValue = if (listening) 1f else IDLE_MIC_ALPHA,
        label = "micAlpha",
    )

    Box(
        modifier = Modifier
            .size(PULSE_DIAMETER)
            .clip(CircleShape)
            .background(HelmColors.Accent.copy(alpha = alpha))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.voice_mic_glyph),
            style = MaterialTheme.typography.headlineMedium,
        )
    }
}

/**
 * Loudness, not a spectrum. It exists to answer "is it hearing me?" — a silent
 * flat line while someone talks is the fastest way to tell that the microphone
 * is being held by something else.
 */
@Composable
private fun Waveform(level: Float, listening: Boolean) {
    val animated by animateFloatAsState(
        targetValue = if (listening) level else 0f,
        label = "voiceLevel",
    )

    Row(
        modifier = Modifier.height(WAVE_HEIGHT),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        repeat(WAVE_BARS) { index ->
            // A fixed profile scaled by the live level: the bars differ from each
            // other so it reads as sound, and the whole shape rises and falls
            // with what the microphone actually hears.
            val profile = MIN_BAR_SCALE + (1f - MIN_BAR_SCALE) * sin(index * BAR_PHASE).let { it * it }
            val height = WAVE_MIN_BAR + (WAVE_HEIGHT - WAVE_MIN_BAR) * animated * profile

            Box(
                modifier = Modifier
                    .size(width = WAVE_BAR_WIDTH, height = height)
                    .clip(RoundedCornerShape(HelmRadius.Sm))
                    .background(HelmColors.Accent),
            )
        }
    }
}

/**
 * What was heard, and the user's chance to fix it.
 *
 * It is a field, not a label: the recogniser gets names and jargon wrong, and
 * retyping a whole dictation because of one word is worse than typing it.
 * Locked while listening, so an incoming partial cannot overwrite a correction
 * mid-keystroke.
 */
@Composable
private fun Transcript(transcript: String, editable: Boolean, onEdit: (String) -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Surface)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
            .padding(HelmSpacing.Md),
    ) {
        if (transcript.isEmpty()) {
            Text(
                text = stringResource(R.string.voice_transcript_placeholder),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        BasicTextField(
            value = transcript,
            onValueChange = onEdit,
            enabled = editable,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = HelmColors.Txt),
            cursorBrush = SolidColor(HelmColors.Accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Cancel and Send, in the lower third, per the mockup's one-handed rule. */
@Composable
private fun Actions(canSend: Boolean, onCancel: () -> Unit, onSend: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(HelmSpacing.Gutter),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        GhostButton(
            text = stringResource(R.string.voice_cancel),
            onClick = onCancel,
            modifier = Modifier.weight(1f),
        )
        PrimaryButton(
            text = stringResource(R.string.voice_send),
            onClick = onSend,
            enabled = canSend,
            modifier = Modifier.weight(1f),
        )
    }
}

/** One line of state, so the screen never leaves the user guessing. */
private val VoiceState.statusRes: Int
    get() = when (phase) {
        VoicePhase.Listening -> R.string.voice_listening
        VoicePhase.Captured -> R.string.voice_captured
        VoicePhase.Idle -> R.string.voice_idle
        VoicePhase.Failed -> when (error) {
            SpeechError.PermissionDenied -> R.string.voice_error_permission
            SpeechError.NoSpeechService -> R.string.voice_error_no_service
            SpeechError.NoMatch -> R.string.voice_error_no_match
            SpeechError.Audio -> R.string.voice_error_audio
            SpeechError.Network -> R.string.voice_error_network
            SpeechError.Busy -> R.string.voice_error_busy
            else -> R.string.voice_error_unknown
        }
    }

private val PULSE_DIAMETER = 112.dp
private val WAVE_HEIGHT = 32.dp
private val WAVE_MIN_BAR = 4.dp
private val WAVE_BAR_WIDTH = 3.dp
private const val WAVE_BARS = 12
private const val BAR_PHASE = 0.7f
private const val MIN_BAR_SCALE = 0.35f
private const val IDLE_MIC_ALPHA = 0.4f
