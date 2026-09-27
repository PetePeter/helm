package com.potatomotato.helm.voice

/**
 * A call's microphone: ONE stream, open from pick-up to hang-up, turning speech
 * into text as it goes. The phone-call shape — the mic is never paused while
 * Helm talks, so the user can interrupt; echo is the recorder's job (it records
 * as voice communication, with the platform's echo canceller on).
 *
 * A port, so [CallController]'s rules run in a JVM test. Every callback arrives
 * on the main thread, and none after [release].
 */
interface CallMic {
    fun start(listener: Listener)

    /** Close the stream for good. Idempotent. */
    fun release()

    interface Listener {
        /** The recogniser's current guess for the utterance in progress. */
        fun onPartial(text: String)

        /** The utterance closed on a pause. May be empty. */
        fun onFinal(text: String)

        /** The mic cannot run at all (no recorder, no model). */
        fun onFailed(reason: String)
    }
}
