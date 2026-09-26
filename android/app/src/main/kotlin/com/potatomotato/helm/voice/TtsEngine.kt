package com.potatomotato.helm.voice

/**
 * The phone's voice, reduced to what a call needs — the speaking twin of
 * [SpeechEngine], behind a port for the same reason: the orderings that matter
 * (a reply mid-sentence, a barge-in, a late "done") are driven in JVM tests.
 */
interface TtsEngine {
    /**
     * Say [text], replacing anything still being said. [onDone] runs once, on the
     * main thread, when the utterance ends on its own or fails — never after
     * [stop] or [release].
     */
    fun speak(text: String, onDone: () -> Unit)

    /** Cut the current utterance short. Its onDone does not follow. */
    fun stop()

    /** Let go of the engine for good. */
    fun release()
}
