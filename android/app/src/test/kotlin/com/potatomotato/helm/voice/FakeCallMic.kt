package com.potatomotato.helm.voice

/**
 * A call microphone the tests speak into by hand. The real one is an always-open
 * stream, so the orderings that matter — words arriving while Helm talks, a late
 * result after a hang-up — are driven here rather than waited for.
 */
class FakeCallMic : CallMic {
    var startCount: Int = 0
        private set
    var releaseCount: Int = 0
        private set

    private var listener: CallMic.Listener? = null

    /** Open, and not yet released. */
    val open: Boolean get() = listener != null

    override fun start(listener: CallMic.Listener) {
        startCount++
        this.listener = listener
    }

    override fun release() {
        releaseCount++
        listener = null
    }

    fun partial(text: String) = listener?.onPartial(text)

    fun final(text: String) = listener?.onFinal(text)

    fun fail(reason: String) = listener?.onFailed(reason)
}
