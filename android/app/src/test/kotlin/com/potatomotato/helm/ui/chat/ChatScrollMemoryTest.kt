package com.potatomotato.helm.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Where a thread reopens. Null means "at the end": a thread never seen this
 * process, or one the reader left at the bottom, opens at the NEW bottom; a
 * thread left mid-scroll opens exactly where it was left.
 */
class ChatScrollMemoryTest {

    private val memory = ChatScrollMemory()

    @Test
    fun `a thread not opened since launch opens at the end`() {
        assertNull(memory.recall("a"))
    }

    @Test
    fun `a thread left scrolled up reopens at that spot`() {
        memory.settle("a", atEnd = false, index = 4, offset = 120)

        assertEquals(ChatScrollMemory.Spot(4, 120), memory.recall("a"))
    }

    @Test
    fun `returning to the end forgets the old spot`() {
        memory.settle("a", atEnd = false, index = 4, offset = 120)
        memory.settle("a", atEnd = true, index = 9, offset = 0)

        assertNull(memory.recall("a"))
    }

    @Test
    fun `each thread keeps its own spot`() {
        memory.settle("a", atEnd = false, index = 4, offset = 120)

        assertNull(memory.recall("b"))
    }
}
