package com.potatomotato.helm.voice

/**
 * A recogniser the tests drive by hand.
 *
 * The real [android.speech.SpeechRecognizer] cannot run in a JVM unit test and,
 * more importantly, cannot be made to deliver the sequences that actually break
 * this state machine — a partial arriving after a cancel, an error mid-utterance,
 * a final with nothing in it. Those are the cases worth testing, so the engine is
 * a port and this is the fake behind it.
 */
class FakeSpeechEngine : SpeechEngine {
    private var listener: SpeechEngine.Listener? = null

    var startCount: Int = 0
        private set
    var stopCount: Int = 0
        private set
    var cancelCount: Int = 0
        private set
    var releaseCount: Int = 0
        private set

    override fun start(listener: SpeechEngine.Listener) {
        startCount++
        this.listener = listener
    }

    override fun stop() {
        stopCount++
    }

    override fun cancel() {
        cancelCount++
    }

    override fun release() {
        releaseCount++
        listener = null
    }

    /** The callbacks, as the platform would deliver them. */
    fun emitReady() = required().onReady()

    fun emitLevel(level: Float) = required().onLevel(level)

    fun emitPartial(text: String) = required().onPartial(text)

    fun emitFinal(text: String) = required().onFinal(text)

    fun emitError(error: SpeechError) = required().onError(error)

    private fun required(): SpeechEngine.Listener =
        listener ?: error("Engine was never started, so the platform would have nobody to call back")
}
