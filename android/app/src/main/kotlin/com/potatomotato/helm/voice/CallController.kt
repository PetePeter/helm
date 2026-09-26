package com.potatomotato.helm.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "Call Helm", as a state machine with no Android in it.
 *
 * The recogniser and the voice are ports ([SpeechEngine], [TtsEngine]) so the
 * orderings that break a hands-free call run in a JVM test. Every method and
 * callback must arrive on ONE thread — the main thread in the app.
 *
 * The rules, each one a way a call goes wrong for someone driving:
 * - listening is continuous: every finalised utterance is sent, once, and the
 *   mic reopens — the platform closes an utterance on every pause;
 * - silence is never sent: an empty or whitespace final is dropped;
 * - the mic is paused while Helm speaks, so Helm cannot hear itself and send
 *   its own words back as the user's — which also means there is no barge-in:
 *   anything heard while speaking is ignored;
 * - muted means heard-but-not-sent.
 */
class CallController(
    private val speech: SpeechEngine,
    private val tts: TtsEngine,
    /** Hand the words to the target. False when the link could not carry them. */
    private val send: (String) -> Boolean,
    /** What is said aloud when a send fails. A resource string in the app. */
    private val sendFailedLine: String,
) : SpeechEngine.Listener {
    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()

    private val queue = ArrayDeque<String>()

    /** Bumped per utterance, so a stale onDone after a stop cannot resume anything. */
    private var utterance = 0

    private val phase get() = _state.value.phase

    fun start() {
        if (phase != CallPhase.Idle) return
        listen()
    }

    fun setMuted(muted: Boolean) {
        _state.value = _state.value.copy(muted = muted, heard = "")
    }

    fun hangUp() {
        if (phase == CallPhase.Ended) return
        queue.clear()
        utterance++
        tts.release()
        speech.release()
        _state.value = _state.value.copy(phase = CallPhase.Ended, heard = "")
    }

    /** A new line from the target. Spoken now, or queued behind what is being said. */
    fun onReply(text: String) = say(text)

    /** A send the link carried was later refused or lost. */
    fun onSendFailed() = say(sendFailedLine)

    override fun onReady() = Unit

    override fun onLevel(level: Float) = Unit

    override fun onPartial(text: String) {
        if (_state.value.muted || phase != CallPhase.Listening) return
        _state.value = _state.value.copy(heard = text)
    }

    override fun onFinal(text: String) {
        if (phase != CallPhase.Listening) return
        val words = text.ifBlank { _state.value.heard }.trim()
        if (_state.value.muted || words.isEmpty()) {
            if (phase == CallPhase.Listening) listen()
            return
        }
        _state.value = _state.value.copy(phase = CallPhase.Sending, heard = words)
        val carried = send(words)
        // A reply can already have started speaking during the send; only an
        // untouched Sending returns to the microphone.
        if (phase == CallPhase.Sending) listen()
        if (!carried) onSendFailed()
    }

    override fun onError(error: SpeechError) {
        if (phase != CallPhase.Listening) return
        // Some recognisers end an utterance with NO_MATCH or a timeout even
        // after streaming partials; what was heard is still the user's words.
        if (error.retryable && _state.value.heard.isNotBlank()) {
            onFinal("")
            return
        }
        if (error.retryable) {
            // Silence, a busy recogniser, a network stumble: a call keeps its line open.
            speech.start(this)
            return
        }
        hangUp()
        _state.value = _state.value.copy(error = error)
    }

    /** Speak now, or queue behind what is being said. */
    private fun say(text: String) {
        if (phase == CallPhase.Idle || phase == CallPhase.Ended || text.isBlank()) return
        queue.addLast(text)
        if (phase != CallPhase.Speaking) speakNext()
    }

    private fun listen() {
        _state.value = _state.value.copy(phase = CallPhase.Listening, heard = "")
        speech.start(this)
    }

    private fun speakNext() {
        val next = queue.removeFirstOrNull()
        if (next == null) {
            listen()
            return
        }
        if (phase != CallPhase.Speaking) speech.cancel()
        _state.value = _state.value.copy(phase = CallPhase.Speaking, spoken = next)
        val mine = ++utterance
        tts.speak(next) { if (mine == utterance && phase == CallPhase.Speaking) speakNext() }
    }
}

enum class CallPhase { Idle, Listening, Sending, Speaking, Ended }

/** Everything the call screen and notification draw. */
data class CallState(
    val phase: CallPhase = CallPhase.Idle,
    val muted: Boolean = false,
    /** The user's current utterance, as heard so far. */
    val heard: String = "",
    /** The last line Helm spoke. */
    val spoken: String = "",
    /** Why the call ended on its own, when it did. */
    val error: SpeechError? = null,
)
