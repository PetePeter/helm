package com.potatomotato.helm.voice

/**
 * Android's call system, answered by hand. Telecom replies to an outgoing call
 * some time after it is asked, so the orderings that matter — a hang-up before
 * the answer, an answer that says no — are driven here rather than waited for.
 */
class FakeCallLine : CallLine {
    /** Set to refuse the call outright, before any answer. */
    var refusal: CallRefusal? = null
    var placeCount: Int = 0
        private set
    var activeCount: Int = 0
        private set
    var endCount: Int = 0
        private set

    private var answer: ((Boolean) -> Unit)? = null

    override fun place(answer: (ready: Boolean) -> Unit): CallRefusal? {
        placeCount++
        refusal?.let { return it }
        this.answer = answer
        return null
    }

    override fun active() {
        activeCount++
    }

    override fun end() {
        endCount++
    }

    fun connect() = answer?.invoke(true)

    fun fail() = answer?.invoke(false)
}

/** The phone's microphone mute, flipped by the test the way a car screen would. */
class FakeMicSwitch(override var muted: Boolean = false) : MicSwitch
