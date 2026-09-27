package com.potatomotato.helm.voice

import com.potatomotato.helm.log.HelmLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "Call Helm", as a state machine with no Android in it.
 *
 * The microphone and the voice are ports ([CallMic], [TtsEngine]) so the
 * orderings that break a hands-free call run in a JVM test. Every method and
 * callback must arrive on ONE thread — the main thread in the app.
 *
 * It behaves like a phone call, not a walkie-talkie:
 * - the mic opens once and stays open; every finalised utterance is sent, once;
 * - silence is never sent: an empty or whitespace final is dropped;
 * - Helm speaks with the mic still open, so the user can talk over it: a
 *   partial of [BARGE_IN_WORDS]+ words while speaking stops Helm, drops what was
 *   queued, and what the user says is sent. Fewer words while speaking is taken
 *   as residual echo of Helm's own voice and ignored;
 * - muted means heard-but-not-sent, and a muted user never interrupts.
 */
class CallController(
    private val mic: CallMic,
    private val tts: TtsEngine,
    /** Hand the words to the target. False when the link could not carry them. */
    private val send: (String) -> Boolean,
    /** What is said aloud when a send fails. A resource string in the app. */
    private val sendFailedLine: String,
) : CallMic.Listener {
    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()

    private val queue = ArrayDeque<String>()

    /** Bumped per utterance and per interruption, so a stale onDone resumes nothing. */
    private var utterance = 0

    private val phase get() = _state.value.phase
    private val live get() = phase != CallPhase.Idle && phase != CallPhase.Ended

    fun start() {
        if (phase != CallPhase.Idle) return
        _state.value = _state.value.copy(phase = CallPhase.Listening)
        mic.start(this)
    }

    fun setMuted(muted: Boolean) {
        _state.value = _state.value.copy(muted = muted, heard = "")
    }

    fun hangUp() {
        if (phase == CallPhase.Ended) return
        queue.clear()
        utterance++
        tts.release()
        mic.release()
        _state.value = _state.value.copy(phase = CallPhase.Ended, heard = "")
    }

    /** A new line from the target. Spoken now, or queued behind what is being said. */
    fun onReply(text: String) = say(text)

    /** A send the link carried was later refused or lost. */
    fun onSendFailed() = say(sendFailedLine)

    override fun onPartial(text: String) {
        if (!live || _state.value.muted) return
        if (phase == CallPhase.Speaking) {
            if (wordCount(text) < BARGE_IN_WORDS) return
            interrupt()
        }
        _state.value = _state.value.copy(heard = text)
    }

    override fun onFinal(text: String) {
        if (!live) return
        val words = text.trim()
        if (_state.value.muted || words.isEmpty()) return
        if (phase == CallPhase.Speaking) {
            if (wordCount(words) < BARGE_IN_WORDS) return
            interrupt()
        }
        _state.value = _state.value.copy(phase = CallPhase.Sending, heard = words)
        val carried = send(words)
        // A reply can already have started speaking during the send.
        if (phase == CallPhase.Sending) _state.value = _state.value.copy(phase = CallPhase.Listening)
        if (!carried) onSendFailed()
    }

    override fun onFailed(reason: String) {
        if (!live) return
        HelmLog.w(HelmLog.UI, "call microphone failed: $reason")
        hangUp()
        _state.value = _state.value.copy(error = SpeechError.Audio)
    }

    /** The user talked over Helm: stop, forget what was queued, listen. */
    private fun interrupt() {
        HelmLog.d(HelmLog.UI) { "call barge-in; ${queue.size} queued line(s) dropped" }
        queue.clear()
        utterance++
        tts.stop()
        _state.value = _state.value.copy(phase = CallPhase.Listening)
    }

    /** Speak now, or queue behind what is being said. */
    private fun say(text: String) {
        if (!live || text.isBlank()) return
        queue.addLast(text)
        if (phase != CallPhase.Speaking) speakNext()
    }

    private fun speakNext() {
        val next = queue.removeFirstOrNull()
        if (next == null) {
            _state.value = _state.value.copy(phase = CallPhase.Listening)
            return
        }
        _state.value = _state.value.copy(phase = CallPhase.Speaking, spoken = next)
        val mine = ++utterance
        tts.speak(next) { if (mine == utterance && phase == CallPhase.Speaking) speakNext() }
    }

    private fun wordCount(text: String): Int = text.trim().split(WHITESPACE).count { it.isNotEmpty() }

    private companion object {
        /** Words heard while Helm speaks before it counts as the user, not echo. */
        const val BARGE_IN_WORDS = 2
        val WHITESPACE = Regex("\\s+")
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
