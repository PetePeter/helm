package com.potatomotato.helm.ui.pairing

/**
 * mm:ss for the waiting screen's elapsed clock.
 *
 * Pulled out of the composable because "does 65 seconds read as 1:05, not
 * 1:5" is a real formatting bug class (missing zero-pad) and is worth
 * asserting on the JVM without standing up Compose.
 */
fun formatElapsed(seconds: Int): String {
    val clamped = seconds.coerceAtLeast(0)
    val m = clamped / 60
    val s = clamped % 60
    return "$m:${s.toString().padStart(2, '0')}"
}
