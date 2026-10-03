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
 * - muted is the phone's own microphone mute ([MicSwitch]), so the car and the
 *   Mute button agree; nothing is sent while muted and a muted user never
 *   interrupts;
 * - it is always a system call too ([CallLine]): one the system refuses never
 *   starts, and the two end together.
 */
class CallController(
    private val mic: CallMic,
    private val tts: TtsEngine,
    /** Hand the words to the target. False when the link could not carry them. */
    private val send: (String) -> Boolean,
    /** What is said aloud when a send fails. A resource string in the app. */
    private val sendFailedLine: String,
    private val line: CallLine,
    private val micSwitch: MicSwitch,
) : CallMic.Listener {
    private val _state = MutableStateFlow(CallState())
    val state: StateFlow<CallState> = _state.asStateFlow()

    private val queue = ArrayDeque<String>()

    /** Bumped per utterance and per interruption, so a stale onDone resumes nothing. */
    private var utterance = 0

    /** Asked the system for the call; its answer has not come yet. */
    private var placing = false

    /** The switch as the call found it, to hand back; null while the call is not up. */
    private var micWasMuted: Boolean? = null

    private val phase get() = _state.value.phase
    private val live get() = phase != CallPhase.Idle && phase != CallPhase.Ended

    /**
     * [opening]: an answered ring speaks first (RingGreeting) so picking up is
     * never met with silence; the mic is already open, so the user can answer
     * over it. The ring already is a system call, so it opens at once.
     *
     * A call the user started asks the system first and opens, listening, only
     * when it is taken.
     */
    fun start(opening: String? = null) {
        if (phase != CallPhase.Idle || placing) return
        if (opening != null) {
            open(opening)
            return
        }
        placing = true
        line.place(::onLineAnswer)?.let { end(refused = it) }
    }

    private fun onLineAnswer(ready: Boolean) {
        if (!placing) return
        if (ready) open(opening = null) else end(refused = CallRefusal.Unavailable)
    }

    private fun open(opening: String?) {
        placing = false
        val muted = micSwitch.muted
        micWasMuted = muted
        _state.value = _state.value.copy(
            phase = CallPhase.Listening,
            muted = muted,
            micMode = if (muted) MicMode.Muted else MicMode.Open,
        )
        line.active()
        mic.start(this)
        opening?.takeIf { it.isNotBlank() }?.let(::say)
    }

    /** The Mute button. */
    fun setMuted(muted: Boolean) {
        if (!live) return
        setMicMode(if (muted) MicMode.Muted else MicMode.Open)
    }

    /** Select open, muted, or key-held microphone operation. */
    fun setMicMode(mode: MicMode) {
        if (!live) return
        val muted = mode != MicMode.Open
        _state.value = _state.value.copy(micMode = mode, pttHeld = false, muted = muted, heard = "")
        micSwitch.muted = muted
    }

    /** The Red Key opens the mic only for the duration of a press in PTT mode. */
    fun setPttKeyHeld(held: Boolean) {
        if (!live || _state.value.micMode != MicMode.PushToTalk || _state.value.pttHeld == held) return
        val muted = !held
        _state.value = _state.value.copy(pttHeld = held, muted = muted, heard = "")
        micSwitch.muted = muted
    }

    /** The switch may have been flipped elsewhere (the car, the system call UI): follow it. */
    fun syncMute() {
        if (!live) return
        val state = _state.value
        // System call controls may also touch AudioManager's mute bit. PTT's
        // release state remains authoritative so only the Red Key can open it.
        val muted = if (state.micMode == MicMode.PushToTalk) !state.pttHeld else micSwitch.muted
        if (micSwitch.muted != muted) micSwitch.muted = muted
        val mode = if (state.micMode == MicMode.PushToTalk) {
            state.micMode
        } else if (muted) {
            MicMode.Muted
        } else {
            MicMode.Open
        }
        if (muted != state.muted || mode != state.micMode) {
            _state.value = state.copy(muted = muted, micMode = mode, heard = "")
        }
    }

    fun hangUp() = end()

    private fun end(error: SpeechError? = null, refused: CallRefusal? = null) {
        if (phase == CallPhase.Ended) return
        placing = false
        queue.clear()
        utterance++
        tts.release()
        mic.release()
        // Never leave the phone's microphone muted behind a call that is over.
        micWasMuted?.let { micSwitch.muted = it }
        micWasMuted = null
        line.end()
        _state.value = _state.value.copy(phase = CallPhase.Ended, heard = "", error = error, refused = refused)
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
        end(error = SpeechError.Audio)
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
    val micMode: MicMode = MicMode.Open,
    val pttHeld: Boolean = false,
    /** The user's current utterance, as heard so far. */
    val heard: String = "",
    /** The last line Helm spoke. */
    val spoken: String = "",
    /** Why the call ended on its own, when it did. */
    val error: SpeechError? = null,
    /** Why the call never started, when the system would not take it. */
    val refused: CallRefusal? = null,
)

enum class MicMode { Open, Muted, PushToTalk }
