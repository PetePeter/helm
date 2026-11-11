package com.potatomotato.helm.ui.plans

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Where a dragged plan lands: the lane whose section (header + rows) is under the finger. */
class LaneDropTest {

    // Visible items top-down: lane a header, two rows, lane b header, one row.
    private val items = listOf(
        LaneDrop.Item("lane:a", top = 0, height = 40),
        LaneDrop.Item("p1", top = 40, height = 60),
        LaneDrop.Item("p2", top = 100, height = 60),
        LaneDrop.Item("lane:b", top = 160, height = 40),
        LaneDrop.Item("p3", top = 200, height = 60),
    )

    @Test
    fun `a finger over a lane's header or rows targets that lane`() {
        assertEquals("a", LaneDrop.laneAt(items, y = 10f))
        assertEquals("a", LaneDrop.laneAt(items, y = 150f))
        assertEquals("b", LaneDrop.laneAt(items, y = 170f))
        assertEquals("b", LaneDrop.laneAt(items, y = 400f))
    }

    @Test
    fun `rows scrolled above the viewport belong to the lane whose header scrolled off`() {
        val scrolled = listOf(LaneDrop.Item("p2", top = -20, height = 60), LaneDrop.Item("lane:b", top = 40, height = 40))
        assertNull(LaneDrop.laneAt(scrolled, y = 10f))
        assertEquals("b", LaneDrop.laneAt(scrolled, y = 50f))
    }

    @Test
    fun `the ungrouped bucket means no sequence`() {
        assertNull(LaneDrop.sequenceIdOf("ungrouped"))
        assertEquals("a", LaneDrop.sequenceIdOf("a"))
    }

    @Test
    fun `a drop back on the plan's own lane is not a move`() {
        assertEquals(false, LaneDrop.isMove(currentSequenceId = "a", targetLane = "a"))
        assertEquals(false, LaneDrop.isMove(currentSequenceId = null, targetLane = "ungrouped"))
        assertEquals(true, LaneDrop.isMove(currentSequenceId = null, targetLane = "a"))
        assertEquals(true, LaneDrop.isMove(currentSequenceId = "a", targetLane = "ungrouped"))
    }
}
