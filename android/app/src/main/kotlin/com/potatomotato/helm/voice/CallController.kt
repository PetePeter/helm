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
 *
 * With a [Standby] it is "Hey Helm" instead of a call: the mic stays open, but
 * only an utterance starting with the wake phrase is sent, as ONE question, and
 * only the ONE reply that answers it is spoken — see [Standby].
 */
class CallController(
    private val speech: SpeechEngine,
    private val tts: TtsEngine,
    /** Hand the words to the target. False when the link could not carry them. */
    private val send: (String) -> Boolean,
    /** What is said aloud when a send fails. A resource string in the app. */
    private val sendFailedLine: String,
    /** Present: standby mode. Absent: a full call. */
    private val standby: Standby? = null,
) : SpeechEngine.Listener {
    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()

    private val queue = ArrayDeque<String>()

    /** Bumped per utterance, so a stale onDone after a stop cannot resume anything. */
    private var utterance = 0

    private val phase get() = _state.value.phase

    /** Standby: the wake phrase was said alone, so the next utterance is the question. */
    private var wokeEmpty = false

    /** Standby: cancels the pending "still waiting" line. */
    private var cancelTimeout: (() -> Unit)? = null

    /** Standby: cancels the expiry of the question window opened by a bare wake. */
    private var cancelWindow: (() -> Unit)? = null

    /** Standby: cancels a backed-off recogniser restart. */
    private var cancelRetry: (() -> Unit)? = null

    /** Standby: the next backed-off restart delay. */
    private var retryDelayMs = RETRY_MIN_MS

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
        settle()
        closeWindow()
        cancelRetry?.invoke()
        cancelRetry = null
        utterance++
        tts.release()
        speech.release()
        _state.value = _state.value.copy(phase = CallPhase.Ended, heard = "")
    }

    /** A new line from the target. Spoken now, or queued behind what is being said. */
    fun onReply(text: String) {
        if (standby != null) {
            // Standby answers the question it asked, once; anything else the
            // target says is not read out to the room.
            if (!_state.value.awaiting) return
            settle()
        }
        say(text)
    }

    /** A send the link carried was later refused or lost. */
    fun onSendFailed() {
        settle()
        say(sendFailedLine)
    }

    override fun onReady() {
        retryDelayMs = RETRY_MIN_MS
    }

    override fun onLevel(level: Float) = Unit

    override fun onPartial(text: String) {
        if (_state.value.muted || phase != CallPhase.Listening) return
        _state.value = _state.value.copy(heard = text)
    }

    override fun onFinal(text: String) {
        if (phase != CallPhase.Listening) return
        retryDelayMs = RETRY_MIN_MS
        val heard = text.ifBlank { _state.value.heard }.trim()
        val words = question(heard)
        if (_state.value.muted || words.isNullOrEmpty()) {
            if (phase == CallPhase.Listening) listen()
            return
        }
        if (standby != null) awaitReply(standby)
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
            if (standby == null) {
                speech.start(this)
            } else {
                // Standby runs for hours: a recogniser failing over and over
                // (no language pack, the mic held elsewhere) must not spin.
                val delay = retryDelayMs
                retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
                cancelRetry?.invoke()
                cancelRetry = standby.schedule(delay) {
                    cancelRetry = null
                    if (phase == CallPhase.Listening) speech.start(this)
                }
            }
            return
        }
        hangUp()
        _state.value = _state.value.copy(error = error)
    }

    /**
     * Standby: the question in [heard], or null to ignore it. The wake phrase
     * said alone is answered with [Standby.yesLine], and the next utterance is
     * taken as the question whether or not it repeats the phrase.
     */
    private fun question(heard: String): String? {
        val standby = standby ?: return heard
        if (wokeEmpty) {
            if (heard.isEmpty()) return null
            closeWindow()
            return stripWakePhrase(heard) ?: heard
        }
        // One question at a time: a second wake would send a question whose
        // answer could never be spoken.
        if (_state.value.awaiting) return null
        val rest = stripWakePhrase(heard) ?: return null
        standby.onWake()
        if (rest.isEmpty()) {
            // The window closes on its own: a sentence said much later is not
            // an answer to "Yes?".
            wokeEmpty = true
            cancelWindow = standby.schedule(standby.questionWindowMs) {
                cancelWindow = null
                wokeEmpty = false
            }
            say(standby.yesLine)
            return null
        }
        return rest
    }

    private fun closeWindow() {
        cancelWindow?.invoke()
        cancelWindow = null
        wokeEmpty = false
    }

    private fun awaitReply(standby: Standby) {
        cancelTimeout?.invoke()
        _state.value = _state.value.copy(awaiting = true)
        cancelTimeout = standby.schedule(standby.timeoutMs) {
            cancelTimeout = null
            // Still awaiting: the late reply will be spoken when it comes.
            if (_state.value.awaiting && phase != CallPhase.Ended) say(standby.stillWaitingLine)
        }
    }

    /** Standby: the question is answered (or abandoned); stop waiting for it. */
    private fun settle() {
        cancelTimeout?.invoke()
        cancelTimeout = null
        if (_state.value.awaiting) _state.value = _state.value.copy(awaiting = false)
    }

    /** Speak now, or queue behind what is being said. */
    private fun say(text: String) {
        if (phase == CallPhase.Idle || phase == CallPhase.Ended || text.isBlank()) return
        queue.addLast(text)
        if (phase != CallPhase.Speaking) speakNext()
    }

    private fun listen() {
        cancelRetry?.invoke()
        cancelRetry = null
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

    private companion object {
        const val RETRY_MIN_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L
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
    /** Standby: a question was sent and its one reply has not been spoken yet. */
    val awaiting: Boolean = false,
)

/**
 * What turns a [CallController] into "Hey Helm" standby. The clock is a port
 * ([schedule] returns its own cancel) so the timeout runs in a JVM test.
 */
class Standby(
    /** The wake phrase was heard: the audible cue that the phone is listening. */
    val onWake: () -> Unit,
    /** Said when the wake phrase arrives with no question after it. */
    val yesLine: String,
    /** Said once when the reply is slow. The reply is still spoken when it comes. */
    val stillWaitingLine: String,
    val timeoutMs: Long,
    /** How long after a bare wake the next utterance still counts as the question. */
    val questionWindowMs: Long = 8_000,
    val schedule: (delayMs: Long, action: () -> Unit) -> () -> Unit,
)
