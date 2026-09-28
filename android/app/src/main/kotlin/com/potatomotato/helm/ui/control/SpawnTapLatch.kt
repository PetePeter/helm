package com.potatomotato.helm.ui.control

/**
 * Debounce for the Start button. The button goes dark on the TAP itself, not
 * when the in-flight flag's recomposition lands, and stays dark for at least
 * [HOLD_MS]: a fast answer (a no-link refusal, or a success whose navigation
 * is a frame behind) would otherwise re-arm it under a bouncing finger.
 * Pure on purpose — the timing rule is logic, not layout.
 */
object SpawnTapLatch {
    const val HOLD_MS = 1_500L

    /**
     * How long until a latch raised at [tappedAtMs] may release: null while the
     * spawn is still in flight (its answer releases it), else the rest of the hold.
     */
    fun releaseInMs(tappedAtMs: Long, inFlight: Boolean, nowMs: Long): Long? =
        if (inFlight) null else (HOLD_MS - (nowMs - tappedAtMs)).coerceAtLeast(0L)
}
