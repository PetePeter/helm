package com.potatomotato.helm.ui.chat

import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.potatomotato.helm.R
import com.potatomotato.helm.data.Draft
import com.potatomotato.helm.voice.AndroidSpeechEngine
import com.potatomotato.helm.voice.SpeechController
import com.potatomotato.helm.voice.SpeechError
import com.potatomotato.helm.voice.VoicePermission
import com.potatomotato.helm.voice.VoicePhase

/**
 * Push-to-talk for the chat composer: hold the mic, watch the words appear in
 * the draft, let go, edit them if the recogniser got a name wrong, send when YOU
 * decide to.
 *
 * Dictation used to be a screen of its own, which meant leaving the conversation
 * to say something into it and coming back with a message already sent. The
 * words belong in the box the user is already looking at, at the caret they had
 * already put there — so this holds the microphone, and [DictationInsert] owns
 * where the text lands.
 *
 * What is Android here is only the parts that must be: the permission launcher,
 * the recogniser, and the clock. The decisions — when a press is too short to be
 * meant, what a partial replaces, which failures get a line of explanation —
 * live in [DictationInsert] and [SpeechController], where they are testable.
 */
@Composable
fun rememberDictation(draft: TextFieldValue, onDraft: (TextFieldValue) -> Unit): DictationHandle {
    val context = LocalContext.current
    val controller = remember { SpeechController(AndroidSpeechEngine(context)) }
    val voice by controller.state.collectAsState()

    // The press reads the draft as it is at that instant; the effect below writes
    // to whatever the latest onDraft is. Captured values would dictate into a
    // draft the user has since edited.
    val currentDraft by rememberUpdatedState(draft)
    val currentOnDraft by rememberUpdatedState(onDraft)

    var anchor by remember { mutableStateOf<Dictation?>(null) }
    var pressedAt by remember { mutableStateOf(0L) }
    var granted by remember { mutableStateOf(VoicePermission.granted(context)) }
    val request = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { allowed -> granted = allowed }

    // Every guess — partial, final, or the empty one a cancel leaves behind —
    // is rendered against the anchor the press captured. The anchor outlives the
    // release on purpose: the final result arrives after the user's thumb is
    // already gone, and it must land in the same place the partials did.
    LaunchedEffect(voice.transcript, voice.phase) {
        val held = anchor ?: return@LaunchedEffect
        val next = held.with(voice.transcript)
        currentOnDraft(TextFieldValue(next.text, TextRange(next.caret)))
    }

    // The microphone must not stay open behind a user who has left the thread.
    DisposableEffect(controller) {
        onDispose { controller.release() }
    }

    return DictationHandle(
        listening = voice.phase == VoicePhase.Listening,
        level = voice.level,
        message = voice.errorMessage,
        onPress = {
            if (!granted) {
                request.launch(VoicePermission.required.first())
            } else {
                pressedAt = SystemClock.elapsedRealtime()
                anchor = DictationInsert.begin(
                    text = currentDraft.text,
                    selectionStart = currentDraft.selection.start,
                    selectionEnd = currentDraft.selection.end,
                )
                controller.start()
            }
        },
        onRelease = {
            // A press too short to have carried a word is a brush past the
            // button, not a dictation: take the microphone back and leave the
            // draft exactly as it was found.
            if (SystemClock.elapsedRealtime() - pressedAt < MIN_HOLD_MILLIS) {
                controller.cancel()
            } else {
                controller.stop()
            }
        },
    )
}

/** What the mic button needs: how to drive it, and what it should look like. */
data class DictationHandle(
    val listening: Boolean,
    val level: Float,
    /** A string resource for the one line of trouble, or null while all is well. */
    val message: Int?,
    val onPress: () -> Unit,
    val onRelease: () -> Unit,
)

/**
 * The failures worth a line of text under the composer.
 *
 * Only the ones the user can act on, or that explain a silence they would
 * otherwise blame on the app. Heard-nothing is not among them: an empty
 * dictation already shows as an unchanged draft, and a red line for it would
 * make every mis-press look like a fault.
 */
private val com.potatomotato.helm.voice.VoiceState.errorMessage: Int?
    get() = if (phase != VoicePhase.Failed) {
        null
    } else {
        when (error) {
            SpeechError.PermissionDenied -> R.string.voice_error_permission
            SpeechError.NoSpeechService -> R.string.voice_error_no_service
            SpeechError.Audio -> R.string.voice_error_audio
            SpeechError.Network -> R.string.voice_error_network
            SpeechError.Busy -> R.string.voice_error_busy
            SpeechError.NoMatch -> null
            null -> null
            else -> R.string.voice_error_unknown
        }
    }

/** Shorter than a syllable: a press this brief cannot have been a dictation. */
private const val MIN_HOLD_MILLIS = 200L
