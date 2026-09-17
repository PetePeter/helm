package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.ui.chat.ComposerStack.Mode
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The composer's debounce, in isolation: which readings may move the action
 * buttons, and which are just the user typing across the wrap threshold.
 */
class ComposerStackTest {

    @Test
    fun `a one line draft keeps the actions in a row`() {
        assertEquals(Mode.Row, ComposerStack().onLineCount(1))
    }

    @Test
    fun `a draft grown to two lines stacks the actions`() {
        val stack = ComposerStack()

        stack.onLineCount(2)

        assertEquals(Mode.Stack, stack.onLineCount(2))
    }

    @Test
    fun `readings alternating between one and two lines never leave the row`() {
        val stack = ComposerStack()

        val modes = listOf(1, 2, 1, 2, 1, 2).map { stack.onLineCount(it) }

        assertEquals(List(6) { Mode.Row }, modes)
    }

    @Test
    fun `a draft holding at two lines stacks once the reading settles`() {
        val stack = ComposerStack()

        assertEquals(Mode.Row, stack.onLineCount(1))
        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Stack, stack.onLineCount(2))
    }

    @Test
    fun `a draft settling back to one line returns to the row the same way`() {
        val stack = ComposerStack()
        stack.onLineCount(2)
        stack.onLineCount(2)

        assertEquals(Mode.Stack, stack.onLineCount(1))
        assertEquals(Mode.Row, stack.onLineCount(1))
    }

    @Test
    fun `exactly stableReadings consecutive readings are what it takes to move`() {
        val stack = ComposerStack(stableReadings = 3)

        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Stack, stack.onLineCount(2))
    }

    @Test
    fun `a reading matching the current mode resets the run toward a switch`() {
        val stack = ComposerStack(stableReadings = 3)

        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Row, stack.onLineCount(2))
        // Two readings toward Stack, then the user deletes back to one line.
        assertEquals(Mode.Row, stack.onLineCount(1))
        // Those two toward Stack were wiped; a fresh run of three is needed.
        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Row, stack.onLineCount(2))
        assertEquals(Mode.Stack, stack.onLineCount(2))
    }
}
