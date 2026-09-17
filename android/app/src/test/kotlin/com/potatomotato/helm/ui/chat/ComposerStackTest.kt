package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.ui.chat.ComposerStack.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The composer's debounce, in isolation: which readings may move the action
 * buttons, which are just the user typing across the wrap threshold, and which
 * taps arrive too soon after a move to be meant.
 *
 * Time is passed in rather than read, so every window below is exact.
 */
class ComposerStackTest {

    @Test
    fun `a one line draft keeps the actions in a row`() {
        assertEquals(Mode.Row, ComposerStack().onLineCount(1, AT))
    }

    @Test
    fun `a draft grown to two lines stacks the actions`() {
        val stack = ComposerStack()

        stack.onLineCount(2, AT)

        assertEquals(Mode.Stack, stack.onLineCount(2, AT))
    }

    @Test
    fun `readings alternating between one and two lines never leave the row`() {
        val stack = ComposerStack()

        val modes = listOf(1, 2, 1, 2, 1, 2).map { stack.onLineCount(it, AT) }

        assertEquals(List(6) { Mode.Row }, modes)
    }

    @Test
    fun `a draft holding at two lines stacks once the reading settles`() {
        val stack = ComposerStack()

        assertEquals(Mode.Row, stack.onLineCount(1, AT))
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Stack, stack.onLineCount(2, AT))
    }

    @Test
    fun `a draft settling back to one line returns to the row the same way`() {
        val stack = ComposerStack()
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)

        assertEquals(Mode.Stack, stack.onLineCount(1, AT))
        assertEquals(Mode.Row, stack.onLineCount(1, AT))
    }

    @Test
    fun `exactly stableReadings consecutive readings are what it takes to move`() {
        val stack = ComposerStack(stableReadings = 3)

        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Stack, stack.onLineCount(2, AT))
    }

    @Test
    fun `a reading matching the current mode resets the run toward a switch`() {
        val stack = ComposerStack(stableReadings = 3)

        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        // Two readings toward Stack, then the user deletes back to one line.
        assertEquals(Mode.Row, stack.onLineCount(1, AT))
        // Those two toward Stack were wiped; a fresh run of three is needed.
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Stack, stack.onLineCount(2, AT))
    }

    @Test
    fun `an untouched composer takes taps straight away`() {
        assertTrue(ComposerStack().acceptsTap(AT))
    }

    @Test
    fun `readings that move nothing leave taps alone`() {
        val stack = ComposerStack()

        stack.onLineCount(1, AT)
        stack.onLineCount(2, AT)

        assertTrue("no switch happened, so nothing moved", stack.acceptsTap(AT))
    }

    @Test
    fun `a tap landing while the buttons move is refused`() {
        val stack = ComposerStack()
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)

        assertFalse(stack.acceptsTap(AT))
        assertFalse(stack.acceptsTap(AT + 249))
    }

    @Test
    fun `the buttons take taps again once they have settled`() {
        val stack = ComposerStack()
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)

        assertTrue(stack.acceptsTap(AT + 250))
    }

    @Test
    fun `each move opens its own window`() {
        val stack = ComposerStack()
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)
        // Settled after the first move, then the draft shrinks and they move back.
        assertTrue(stack.acceptsTap(AT + 250))
        stack.onLineCount(1, AT + 300)
        stack.onLineCount(1, AT + 300)

        assertFalse(stack.acceptsTap(AT + 400))
        assertTrue(stack.acceptsTap(AT + 550))
    }

    @Test
    fun `a sent draft resets the mode the run and the window`() {
        val stack = ComposerStack(stableReadings = 3)
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)
        stack.onLineCount(2, AT)

        stack.reset()

        assertTrue("the emptied field is not a move to guard", stack.acceptsTap(AT))
        assertEquals(Mode.Row, stack.onLineCount(1, AT))
        // The run toward Stack went with it: a full fresh run is needed again.
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Row, stack.onLineCount(2, AT))
        assertEquals(Mode.Stack, stack.onLineCount(2, AT))
    }

    /** An arbitrary non-zero epoch; only the deltas matter. */
    private companion object {
        const val AT = 1_000_000L
    }
}
