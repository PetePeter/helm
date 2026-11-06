package com.potatomotato.helm.voice

/**
 * The turn hold, by hand. [immediate] closes every turn at once — one final, one
 * send — for the cases that are not about stitching; otherwise [elapse] fires it.
 */
class FakeTurnTimer(var immediate: Boolean = true) : TurnTimer {
    private var armed: (() -> Unit)? = null
    var lastDelayMs: Long = 0
        private set

    val isArmed: Boolean get() = armed != null

    override fun arm(delayMs: Long, fire: () -> Unit): () -> Unit {
        lastDelayMs = delayMs
        if (immediate) {
            fire()
            return {}
        }
        armed = fire
        return { if (armed === fire) armed = null }
    }

    /** The hold ran out with nobody talking. */
    fun elapse() {
        val fire = armed ?: return
        armed = null
        fire()
    }
}
