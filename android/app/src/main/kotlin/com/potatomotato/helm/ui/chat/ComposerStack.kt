package com.potatomotato.helm.ui.chat

/**
 * Whether the chat composer's action buttons (terminal, mic, send) sit in a
 * horizontal row beside the draft, or stack vertically along the right edge —
 * and when a tap on them is the user's rather than an accident of that move.
 *
 * Pure on purpose, like [com.potatomotato.helm.ui.control.RenameRules]: the
 * interesting part is not layout but when the layout is allowed to change. A
 * one-line draft keeps the buttons in a row; once the text box wraps to a
 * second line they move to the vertical stack. Typing near that wrap threshold
 * makes the line count flicker between 1 and 2, and an undebounced layout
 * flip-flops under the user's thumbs — so a switch only takes effect after the
 * new condition has been observed [stableReadings] times in a row. Any reading
 * that agrees with the current mode resets that run.
 *
 * Settling readings is not enough on its own. When the swap does happen the
 * circles land in new places, and a thumb already on its way down hits whichever
 * button moved under it — send when it meant mic. So a move also opens a short
 * dead window: [acceptsTap] is false for [settleMillis] afterwards, and the
 * buttons ask before they fire.
 *
 * No coroutines and no clock of its own: the caller feeds line-count readings
 * and the current time, and renders whatever [onLineCount] answers, which makes
 * the whole thing deterministically testable on the JVM.
 */
class ComposerStack(
    private val stableReadings: Int = DEFAULT_STABLE_READINGS,
    private val settleMillis: Long = DEFAULT_SETTLE_MILLIS,
) {

    enum class Mode {
        /** Buttons in a horizontal row beside the single-line draft. */
        Row,

        /** Buttons stacked vertically on the right edge of the tall draft. */
        Stack,
    }

    private var mode = Mode.Row
    private var run = 0

    /** When the buttons last moved, or null while they have not moved at all. */
    private var movedAt: Long? = null

    /** Feed the draft's current line count and the time; get the mode to lay out with. */
    fun onLineCount(lines: Int, nowMs: Long): Mode {
        val wanted = if (lines >= STACK_LINES) Mode.Stack else Mode.Row
        if (wanted == mode) {
            run = 0
        } else if (++run >= stableReadings.coerceAtLeast(1)) {
            mode = wanted
            run = 0
            movedAt = nowMs
        }
        return mode
    }

    /** Whether a tap now belongs to the user, or to buttons that just moved. */
    fun acceptsTap(nowMs: Long): Boolean {
        val moved = movedAt ?: return true
        return nowMs - moved >= settleMillis
    }

    /**
     * Back to the starting state — for a sent or cleared draft.
     *
     * The field is empty again, so the mode it will be laid out in is known
     * rather than debounced, and a half-finished run toward a switch describes a
     * draft that no longer exists.
     */
    fun reset() {
        mode = Mode.Row
        run = 0
        movedAt = null
    }

    private companion object {
        /** A draft at two or more wrapped lines is too tall to share a row. */
        const val STACK_LINES = 2

        /** Enough readings to outlast a character flickering across the wrap. */
        const val DEFAULT_STABLE_READINGS = 2

        /** About a thumb's travel: long enough to cover a move, short enough not to feel dead. */
        const val DEFAULT_SETTLE_MILLIS = 250L
    }
}
