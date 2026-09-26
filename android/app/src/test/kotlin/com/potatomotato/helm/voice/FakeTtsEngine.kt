package com.potatomotato.helm.voice

/**
 * A text-to-speech engine the tests finish by hand.
 *
 * The point is the same as [FakeSpeechEngine]: the orderings that break a call —
 * a reply landing mid-sentence, a barge-in while speaking, a late "done" after a
 * stop — are the ones the platform engine cannot be made to produce on demand.
 */
class FakeTtsEngine : TtsEngine {
    /** Everything asked to be spoken, in order. */
    val spoken = mutableListOf<String>()

    var stopCount: Int = 0
        private set
    var releaseCount: Int = 0
        private set

    private var onDone: (() -> Unit)? = null

    /** True while an utterance has been started and not yet finished or stopped. */
    val speaking: Boolean get() = onDone != null

    override fun speak(text: String, onDone: () -> Unit) {
        spoken += text
        this.onDone = onDone
    }

    override fun stop() {
        stopCount++
        onDone = null
    }

    override fun release() {
        releaseCount++
        onDone = null
    }

    /** The current utterance reached its end. */
    fun finish() {
        val done = onDone ?: error("Nothing is being spoken, so the platform would have nothing to finish")
        onDone = null
        done()
    }
}
