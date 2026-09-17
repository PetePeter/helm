package com.potatomotato.helm.ui.chat

/**
 * Whether the chat composer's action buttons (terminal, mic, send) sit in a
 * horizontal row beside the draft, or stack vertically along the right edge.
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
 * No time and no coroutines: the caller feeds line-count readings and renders
 * whatever [onLineCount] answers, which makes the whole thing deterministically
 * testable on the JVM.
 */
class ComposerStack(private val stableReadings: Int = DEFAULT_STABLE_READINGS) {

    enum class Mode {
        /** Buttons in a horizontal row beside the single-line draft. */
        Row,

        /** Buttons stacked vertically on the right edge of the tall draft. */
        Stack,
    }

    private var mode = Mode.Row
    private var run = 0

    /** Feed the draft's current line count; get the mode to lay out with. */
    fun onLineCount(lines: Int): Mode {
        val wanted = if (lines >= STACK_LINES) Mode.Stack else Mode.Row
        if (wanted == mode) {
            run = 0
        } else if (++run >= stableReadings.coerceAtLeast(1)) {
            mode = wanted
            run = 0
        }
        return mode
    }

    private companion object {
        /** A draft at two or more wrapped lines is too tall to share a row. */
        const val STACK_LINES = 2

        /** Enough readings to outlast a character flickering across the wrap. */
        const val DEFAULT_STABLE_READINGS = 2
    }
}
