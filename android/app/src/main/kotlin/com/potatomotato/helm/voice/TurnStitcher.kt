package com.potatomotato.helm.voice

import java.util.Locale

/**
 * Joins a call's finals into one turn, so a breath mid-thought is not "send".
 *
 * The recogniser closes an utterance on every short pause; the user has not
 * finished. Finals are kept with the pause before each one written inline
 * ("[pause 0.8s]"), so the agent reading the turn can tell hesitation from
 * separate thoughts. When the turn closes is [CallController]'s call; this only
 * keeps the words and the gaps.
 *
 * The same concept as Timbre's P-1172; deliberately not shared code.
 */
class TurnStitcher {
    private val parts = StringBuilder()
    private var lastFinalAt = 0L

    /** When the user started speaking again after the last final; null while still quiet. */
    private var resumedAt: Long? = null

    val pending: Boolean get() = parts.isNotEmpty()

    /** The user is speaking at [at]: the first call after a final marks where its pause ended. */
    fun speech(at: Long) {
        if (pending && resumedAt == null) resumedAt = at
    }

    /** A non-empty final heard at [at]. */
    fun add(text: String, at: Long) {
        if (pending) {
            val gap = (resumedAt ?: at) - lastFinalAt
            parts.append(' ')
            if (gap >= MIN_MARKED_PAUSE_MS) parts.append(pauseMarker(gap)).append(' ')
        }
        parts.append(text)
        lastFinalAt = at
        resumedAt = null
    }

    /** The turn so far, and start a new one. */
    fun take(): String = parts.toString().also { clear() }

    fun clear() {
        parts.setLength(0)
        resumedAt = null
    }

    private companion object {
        /** Shorter gaps are the recogniser's own endpointing, not a pause worth reading. */
        const val MIN_MARKED_PAUSE_MS = 300L

        fun pauseMarker(ms: Long) = String.format(Locale.ROOT, "[pause %.1fs]", ms / 1000.0)
    }
}
