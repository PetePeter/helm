package com.potatomotato.helm.ui.chat

import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType

@Composable
internal fun Composer(
    draft: TextFieldValue,
    onDraft: (TextFieldValue) -> Unit,
    onTerminal: () -> Unit,
    onCall: (() -> Unit)?,
    onAttach: (() -> Unit)?,
    onSend: (String) -> Unit,
    allowEmpty: Boolean = false,
) {
    Hairline()
    val dictation = rememberDictation(draft = draft, onDraft = onDraft, onSubmit = onSend)
    if (dictation.message != null) ComposerNote(dictation.message)

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val horizontalActions = maxWidth >= HORIZONTAL_COMPOSER_MIN_WIDTH
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(HelmColors.Surface)
                .padding(HelmSpacing.Md)
                // A growing draft lifts the composer smoothly rather than snapping.
                .animateContentSize(),
            // Bottom-anchored: a multiline draft grows the field upward, and the
            // controls stay where the thumb rests instead of riding to centre.
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            ComposerDraft(
                draft = draft,
                onDraft = onDraft,
                modifier = Modifier.weight(1f).heightIn(
                    min = if (horizontalActions) HelmSize.MicButton else STACKED_CONTROLS_HEIGHT,
                ),
            )
            ComposerControls(
                horizontal = horizontalActions,
                dictation = dictation,
                hasText = draft.text.isNotBlank(),
                allowEmpty = allowEmpty,
                onTerminal = onTerminal,
                onCall = onCall,
                onSend = { onSend(draft.text) },
                onAttach = onAttach,
            )
        }
    }
}

@Composable
private fun ComposerControls(
    horizontal: Boolean,
    dictation: DictationHandle,
    hasText: Boolean,
    allowEmpty: Boolean,
    onTerminal: () -> Unit,
    onCall: (() -> Unit)?,
    onSend: () -> Unit,
    onAttach: (() -> Unit)?,
) {
    val controls: @Composable () -> Unit = {
        ComposerTerminal(onTerminal)
        ComposerVoice(dictation = dictation, onCall = onCall)
        ComposerSend(hasText = hasText, allowEmpty = allowEmpty, onSend = onSend, onAttach = onAttach)
    }
    if (horizontal) {
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm), verticalAlignment = Alignment.CenterVertically) {
            controls()
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm), horizontalAlignment = Alignment.End) {
            controls()
        }
    }
}

/** A line of voice trouble, said where the user is standing. */
@Composable
private fun ComposerNote(messageRes: Int) {
    Text(
        text = stringResource(messageRes),
        color = HelmColors.Danger,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
    )
}

@Composable
private fun ComposerDraft(
    draft: TextFieldValue,
    onDraft: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Bg)
            .border(HelmSize.Hairline, HelmColors.Accent.copy(alpha = 0.65f), RoundedCornerShape(HelmRadius.Md))
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Md),
    ) {
        if (draft.text.isEmpty()) {
            Text(
                text = stringResource(R.string.chat_placeholder),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        BasicTextField(
            value = draft,
            onValueChange = onDraft,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
            cursorBrush = SolidColor(HelmColors.Accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// The terminal preview is deliberately the same Snapshot journey as the
// overflow action: one pull/navigation path, merely reachable where a
// user is already composing a reply.
@Composable
private fun ComposerTerminal(onTerminal: () -> Unit) {
    val terminalLabel = stringResource(R.string.control_action_snapshot)
    Box(
        modifier = Modifier
            .size(HelmSize.MicButton)
            .clip(CircleShape)
            .background(HelmColors.Accent)
            .clickable(onClick = onTerminal),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "🖥",
            color = HelmColors.OnAccent,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { contentDescription = terminalLabel },
        )
    }
}

/**
 * The mic is permanent and first-class, not an option inside a keyboard: away
 * from the desk it is the primary way a reply gets written, so it holds the
 * thumb position and send sits beside it.
 *
 * Hold to talk. It is a press, not a tap, because that is the gesture that has
 * an obvious end — releasing — and because a dictation nobody ended is a
 * microphone left open. While held it wears a halo that breathes with what the
 * recogniser is hearing: a flat ring while someone speaks is how you tell the
 * microphone is being held by something else.
 */
@Composable
private fun ComposerVoice(dictation: DictationHandle, onCall: (() -> Unit)?) {
    val context = LocalContext.current
    val prefs = remember { context.applicationContext.getSharedPreferences(VOICE_PREFS, Context.MODE_PRIVATE) }
    var mode by remember { mutableStateOf(VoiceMode.of(prefs.getString(VOICE_MODE_KEY, null))) }
    var choosing by remember { mutableStateOf(false) }
    val choose: (VoiceMode) -> Unit = { next ->
        mode = next
        choosing = false
        prefs.edit().putString(VOICE_MODE_KEY, next.name).apply()
    }

    Box {
        when (mode) {
            VoiceMode.Mic -> ComposerMic(dictation = dictation, onSlideUp = { choosing = true })
            VoiceMode.Phone -> ComposerPhone(onCall = onCall, onLongPress = { choosing = true })
        }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.voice_mode_mic)) },
                onClick = { choose(VoiceMode.Mic) },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.voice_mode_phone)) },
                onClick = { choose(VoiceMode.Phone) },
            )
        }
    }
}

/**
 * The composer's one voice button has two modes: it is either the mic (hold
 * to dictate) or the phone (tap to call). Sliding up off a held mic, or holding
 * the phone, offers the other. The choice is remembered.
 */
private enum class VoiceMode {
    Mic, Phone;

    companion object {
        fun of(name: String?): VoiceMode = entries.firstOrNull { it.name == name } ?: Mic
    }
}

/**
 * Hold to dictate. While held it wears a halo that breathes with what the
 * recogniser is hearing: a flat ring while someone speaks is how you tell the
 * microphone is being held by something else. Sliding up abandons the
 * dictation and asks for the mode switch instead.
 */
@Composable
private fun ComposerMic(dictation: DictationHandle, onSlideUp: () -> Unit) {
    val halo by animateFloatAsState(
        targetValue = if (dictation.listening) MIN_HALO + (1f - MIN_HALO) * dictation.level else 0f,
        label = "micHalo",
    )
    val accent = HelmColors.Accent
    val micLabel = stringResource(R.string.voice_mic_hold)
    val slidePx = with(LocalDensity.current) { SLIDE_TO_SWITCH.toPx() }

    // The handle changes on every loudness reading. Keying the gesture on it
    // would restart the pointer filter mid-hold — cancelling the very press it
    // is meant to be tracking — so the gesture is installed once and reads the
    // latest handle through this.
    val current by rememberUpdatedState(dictation)
    val currentSlideUp by rememberUpdatedState(onSlideUp)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }

    HoldHint(pressed) {
        Box(
            modifier = Modifier
                .size(HelmSize.MicButton)
                .drawBehind {
                    if (halo <= 0f) return@drawBehind
                    val core = size.minDimension / 2
                    // Wider is fainter, so the fall-off reads as light, not rings.
                    drawCircle(accent.copy(alpha = 0.10f * halo), radius = core + HALO_SPREAD.toPx() * halo)
                    drawCircle(accent.copy(alpha = 0.22f * halo), radius = core + HALO_SPREAD.toPx() * halo * 0.5f)
                }
                .clip(CircleShape)
                .background(accent)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        pressed = true
                        current.onPress()
                        var slid = false
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            if (down.position.y - change.position.y > slidePx) {
                                slid = true
                                break
                            }
                        }
                        // A finger lifted and a gesture the system took away are the
                        // same "stop"; a slide up keeps nothing and switches modes.
                        pressed = false
                        if (slid) {
                            current.onCancel()
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            currentSlideUp()
                        } else {
                            current.onRelease()
                        }
                    }
                }
                .semantics { contentDescription = micLabel },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.voice_mic_glyph),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** Tap to call; hold for the mode switch. Dark while a call elsewhere is live. */
@Composable
private fun ComposerPhone(onCall: (() -> Unit)?, onLongPress: () -> Unit) {
    val label = stringResource(R.string.control_action_call)
    val currentCall by rememberUpdatedState(onCall)
    val currentLongPress by rememberUpdatedState(onLongPress)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }
    HoldHint(pressed, onAccent = onCall != null) {
        Box(
            modifier = Modifier
                .size(HelmSize.MicButton)
                .clip(CircleShape)
                .background(if (onCall != null) HelmColors.Accent else HelmColors.Surface2)
                .pointerInput(Unit) {
                    detectTapGestures(
                        onPress = {
                            pressed = true
                            tryAwaitRelease()
                            pressed = false
                        },
                        onTap = { currentCall?.invoke() },
                        onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            currentLongPress()
                        },
                    )
                }
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.control_glyph_call),
                color = if (onCall != null) HelmColors.OnAccent else HelmColors.Dim,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

// Send is a circle like the mic, not a caption: the composer's controls
// read as one pair, and the one that delivers sits last — where a thumb
// already is. Until there is something to send it is dark — an enabled
// control that does nothing is worse than a visibly dead one.
//
// Like the voice button it has two modes, switched by holding it: Send, and
// Attach (📎, tap to pick a file). Typed text always wins — with words in the
// box the button sends, so attach mode can never swallow a message.
@Composable
private fun ComposerSend(hasText: Boolean, allowEmpty: Boolean, onSend: () -> Unit, onAttach: (() -> Unit)?) {
    val context = LocalContext.current
    val prefs = remember { context.applicationContext.getSharedPreferences(VOICE_PREFS, Context.MODE_PRIVATE) }
    var attachMode by remember { mutableStateOf(prefs.getBoolean(ATTACH_MODE_KEY, false)) }
    var choosing by remember { mutableStateOf(false) }
    val choose: (Boolean) -> Unit = { next ->
        attachMode = next
        choosing = false
        prefs.edit().putBoolean(ATTACH_MODE_KEY, next).apply()
    }
    val attaching = attachMode && !hasText && !allowEmpty && onAttach != null
    val enabled = hasText || allowEmpty || attaching
    val currentSend by rememberUpdatedState(onSend)
    val currentAttach by rememberUpdatedState(onAttach)
    val currentAttaching by rememberUpdatedState(attaching)
    val sendLabel = stringResource(if (attaching) R.string.chat_attach else R.string.chat_send)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }
    Box {
        HoldHint(pressed, holdable = onAttach != null, onAccent = enabled) {
            Box(
                modifier = Modifier
                    .size(HelmSize.MicButton)
                    .clip(CircleShape)
                    .background(if (enabled) HelmColors.Accent else HelmColors.Surface2)
                    .then(
                        if (enabled) Modifier else Modifier.border(HelmSize.Hairline, HelmColors.Line, CircleShape),
                    )
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onPress = {
                                pressed = currentAttach != null
                                tryAwaitRelease()
                                pressed = false
                            },
                            onTap = { if (currentAttaching) currentAttach?.invoke() else currentSend() },
                            // Nothing to switch to without an attach path.
                            onLongPress = {
                                if (currentAttach != null) {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    choosing = true
                                }
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(if (attaching) R.string.chat_attach_glyph else R.string.chat_send_glyph),
                    // Dim rather than Faint while disabled: Faint is the placeholder's
                    // colour, and a send arrow in it disappears against the Surface2
                    // circle — which reads as a layout hole, not a dead button.
                    color = if (enabled) HelmColors.OnAccent else HelmColors.Dim,
                    style = HelmType.SendGlyph,
                    modifier = Modifier.semantics { contentDescription = sendLabel },
                )
            }
        }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.send_mode_send)) }, onClick = { choose(false) })
            DropdownMenuItem(text = { Text(stringResource(R.string.send_mode_attach)) }, onClick = { choose(true) })
        }
    }
}

/**
 * Says a composer circle has a second, HELD action. At rest: a small dot on
 * its rim. While held: the circle grows over exactly the long-press time and a
 * ^ rises above it, so the hold visibly fills up to the moment the menu opens
 * — letting go before then is just a tap.
 *
 * [onAccent]: the button is filled with the accent, so the dot is drawn light;
 * on a greyed-out button the same light dot vanishes, so it is drawn in the
 * accent instead — the hint must read on both.
 */
@Composable
private fun HoldHint(pressed: Boolean, holdable: Boolean = true, onAccent: Boolean = true, content: @Composable () -> Unit) {
    val holdMs = LocalViewConfiguration.current.longPressTimeoutMillis.toInt()
    val scale by animateFloatAsState(
        targetValue = if (pressed) HOLD_SCALE else 1f,
        animationSpec = tween(durationMillis = if (pressed) holdMs else HOLD_RELEASE_MS),
        label = "holdHint",
    )
    Box(contentAlignment = Alignment.Center) {
        Box(modifier = Modifier.graphicsLayer { scaleX = scale; scaleY = scale }) { content() }
        if (!holdable) return@Box
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(x = -HOLD_DOT_INSET, y = -HOLD_DOT_INSET)
                .size(HOLD_DOT)
                .clip(CircleShape)
                .background(if (onAccent) HelmColors.OnAccent.copy(alpha = 0.8f) else HelmColors.Accent),
        )
        if (pressed) {
            Text(
                text = stringResource(R.string.hold_hint_arrow),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.align(Alignment.TopCenter).offset(y = -HOLD_ARROW_RISE),
            )
        }
    }
}

private const val HOLD_SCALE = 1.25f
private const val HOLD_RELEASE_MS = 120
private val HOLD_DOT = 5.dp
private val HOLD_DOT_INSET = 6.dp
private val HOLD_ARROW_RISE = 18.dp

/**
 * The three circles stacked with their gaps — the composer field's minimum
 * height, so the box and the controls beside it always read as one block.
 */
private val STACKED_CONTROLS_HEIGHT = HelmSize.MicButton * 3 + HelmSpacing.Sm * 2
private val HORIZONTAL_COMPOSER_MIN_WIDTH = 480.dp

/** How far the listening halo reaches past the mic at full loudness. */
private val HALO_SPREAD = 14.dp

/** A held mic glows even in silence: the halo says "open", the swell says "heard". */
private const val MIN_HALO = 0.35f

/** How far up a held mic must slide to become the mode switch. */
private val SLIDE_TO_SWITCH = 48.dp

private const val VOICE_PREFS = "helm_composer"
private const val VOICE_MODE_KEY = "voice_mode"
private const val ATTACH_MODE_KEY = "send_attach_mode"
