package com.potatomotato.helm.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Dictation, as a state machine with no Android in it.
 *
 * The recogniser is reached through [SpeechEngine] so the sequences that
 * actually break this — a partial after a cancel, an empty final, an error
 * mid-utterance — can be driven in a plain JVM test. Android's SpeechRecognizer
 * is a callback surface with no useful state of its own; the state that the
 * screen needs lives here.
 *
 * Nothing in here sends anything, and nothing in here edits: the words land in
 * the chat composer's own draft, which is where the user corrects them and where
 * the decision to send stays theirs.
 */
class SpeechController(private val engine: SpeechEngine) : SpeechEngine.Listener {
    private val _state = MutableStateFlow(VoiceState())
    val state: StateFlow<VoiceState> = _state.asStateFlow()

    /**
     * The mic button's finger. A pause ends the platform's UTTERANCE, not the
     * dictation: while the finger is down, a final or a silence error restarts
     * listening and the words keep accumulating. Only releasing the button
     * (stop) decides the dictation is over.
     */
    private var held = false

    /** Segments the recogniser has finalised during this hold, joined. */
    private var committed = ""

    /** The current utterance's latest partial — the recogniser's whole guess for it. */
    private var pending = ""

    /**
     * Begin (or restart) a dictation. Starting wipes whatever was captured
     * before: tapping the mic again means "say it differently", not "add to it".
     */
    fun start() {
        // Re-registering mid-utterance double-delivers every later callback and
        // cancels the recognition in flight on the real recogniser.
        if (_state.value.phase == VoicePhase.Listening) return

        held = true
        committed = ""
        pending = ""
        _state.value = VoiceState(phase = VoicePhase.Listening)
        engine.start(this)
    }

    /** The finger came up. Ask for the final result; it arrives as [onFinal]. */
    fun stop() {
        if (_state.value.phase != VoicePhase.Listening) return
        held = false
        engine.stop()
    }

    /** Throw the utterance away. Nothing was sent, and nothing is kept. */
    fun cancel() {
        held = false
        committed = ""
        pending = ""
        engine.cancel()
        _state.value = VoiceState()
    }

    /** Leaving the screen. The microphone must not stay held open behind it. */
    fun release() {
        held = false
        committed = ""
        pending = ""
        engine.release()
        _state.value = VoiceState()
    }

    override fun onReady() {
        // The platform is warmed up; the screen already says Listening.
    }

    override fun onLevel(level: Float) {
        if (_state.value.phase != VoicePhase.Listening) return
        _state.value = _state.value.copy(level = level)
    }

    override fun onPartial(text: String) {
        if (_state.value.phase != VoicePhase.Listening) return
        // REPLACE, within the current utterance. A partial is the recogniser's
        // whole current guess, never a delta — appending is what produces
        // "test test test test test". Finalised segments stay committed.
        pending = text
        _state.value = _state.value.copy(transcript = join(committed, text))
    }

    override fun onFinal(text: String) {
        if (_state.value.phase != VoicePhase.Listening) return

        // An empty final is common and does NOT mean "the user said nothing" —
        // it means this final carries no improvement on the last partial.
        val segment = text.ifBlank { pending }.trim()
        pending = ""
        if (segment.isNotEmpty()) committed = join(committed, segment)

        if (held) {
            // The platform closed the utterance — usually its end-of-speech
            // silence, i.e. the user paused. The finger is still down, so the
            // dictation is not over: reopen the mic and carry on from what was
            // committed. Restarting in place is what makes the pause seamless.
            engine.start(this)
            _state.value = _state.value.copy(transcript = committed)
            return
        }

        _state.value = if (committed.isEmpty()) {
            VoiceState(phase = VoicePhase.Failed, error = SpeechError.NoMatch)
        } else {
            VoiceState(phase = VoicePhase.Captured, transcript = committed)
        }
    }

    override fun onError(error: SpeechError) {
        // The pause-adjacent stumbles: silence timeouts and a busy recogniser.
        // With the finger still down they restart the utterance rather than
        // ending it — the user was holding the mic because they meant to talk.
        if (
            _state.value.phase == VoicePhase.Listening &&
            held &&
            (error == SpeechError.NoMatch || error == SpeechError.Busy)
        ) {
            engine.start(this)
            return
        }

        // Whatever was already heard survives the stumble: a long dictation is
        // expensive to redo, and Failed with text still on screen is recoverable
        // where a wipe is not.
        _state.value = _state.value.copy(
            phase = VoicePhase.Failed,
            error = error,
            level = 0f,
        )
    }

    private fun join(left: String, right: String): String = when {
        left.isEmpty() -> right
        right.isEmpty() -> left
        else -> "$left $right"
    }
}

/** What the voice screen is doing, as one value. */
enum class VoicePhase {
    /** Nothing heard yet, or nothing left after an edit or a cancel. */
    Idle,

    /** The microphone is open. */
    Listening,

    /** There is text, and the user may edit it or send it. */
    Captured,

    /** Something went wrong. Never a dead end — see [SpeechError.retryable]. */
    Failed,
}

/**
 * The recogniser's failures, reduced to the ones the screen reacts to
 * differently. Anything else is [Unknown] — a longer enum would not change
 * what the user is offered.
 */
enum class SpeechError(val retryable: Boolean) {
    /** RECORD_AUDIO was refused. Retrying just fails again; Settings is the route. */
    PermissionDenied(retryable = false),

    /** No recognition service on the device at all. Nothing to retry against. */
    NoSpeechService(retryable = false),

    /** Heard, but nothing intelligible. */
    NoMatch(retryable = true),

    /** The microphone or the audio stack failed. */
    Audio(retryable = true),

    /**
     * The recogniser wanted the network. Offline recognition is requested
     * (EXTRA_PREFER_OFFLINE), but a device with no downloaded language pack
     * falls back to the network and fails without one.
     */
    Network(retryable = true),

    /** The recogniser is busy, usually another app holding the microphone. */
    Busy(retryable = true),

    Unknown(retryable = true),
}

/**
 * Platform error code → [SpeechError]. Lives here, not in AndroidSpeechEngine,
 * because it IS a decision (which failures get which message) and decisions
 * belong where they can be tested — the engine file is translation only.
 */
fun speechErrorOf(code: Int): SpeechError = when (code) {
    1, // ERROR_NETWORK_TIMEOUT
    2, // ERROR_NETWORK
    -> SpeechError.Network

    3, // ERROR_AUDIO
    5, // ERROR_CLIENT
    -> SpeechError.Audio

    4, // ERROR_SERVER — the service answered, but cannot recognise.
    -> SpeechError.NoSpeechService

    6, // ERROR_SPEECH_TIMEOUT
    7, // ERROR_NO_MATCH
    -> SpeechError.NoMatch

    8, // ERROR_RECOGNIZER_BUSY
    -> SpeechError.Busy

    9, // ERROR_INSUFFICIENT_PERMISSIONS
    -> SpeechError.PermissionDenied

    /**
     * 12 ERROR_LANGUAGE_NOT_SUPPORTED and 13 ERROR_LANGUAGE_UNAVAILABLE are the
     * offline-path failures: the recognizer started, then found no downloaded
     * language pack for the locale (13 is what the on-device audit tablet
     * reports, within 200ms of "Offline recognizer - start listening"). They
     * read as [SpeechError.Network] because that error already says the honest
     * thing: no offline language pack, and no network fallback.
     */
    12, 13 -> SpeechError.Network

    else -> SpeechError.Unknown
}

/** Everything the voice screen draws. */
data class VoiceState(
    val phase: VoicePhase = VoicePhase.Idle,
    val transcript: String = "",
    val error: SpeechError? = null,
    /** Speech loudness, 0f..1f — the waveform. Zero whenever not listening. */
    val level: Float = 0f,
)

/**
 * The recogniser, reduced to what the state machine needs.
 *
 * Keeping the framework behind a port is the same rule the BLE layer follows:
 * logic lives on this side, Android classes stay on the other.
 */
interface SpeechEngine {
    fun start(listener: Listener)

    /** Finish the utterance and deliver a final result. */
    fun stop()

    /** Abandon the utterance. No result follows. */
    fun cancel()

    /** Let go of the microphone for good. */
    fun release()

    interface Listener {
        fun onReady()
        fun onLevel(level: Float)
        fun onPartial(text: String)
        fun onFinal(text: String)
        fun onError(error: SpeechError)
    }
}
