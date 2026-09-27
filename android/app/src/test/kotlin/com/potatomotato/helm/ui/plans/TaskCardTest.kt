package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanTask
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskCardTest {

    private val now = 10_000L

    @Test
    fun `a task with no live timer says so, because nobody will check it`() {
        assertEquals(NextCheck.NoTimer, TaskCard.nextCheck(HelmPlanTask(), now))
    }

    @Test
    fun `a check at or before now is due, a later one is shown at its time`() {
        assertEquals(NextCheck.DueNow, TaskCard.nextCheck(HelmPlanTask(nextCheckAtEpochMs = now), now))
        assertEquals(NextCheck.At(now + 1), TaskCard.nextCheck(HelmPlanTask(nextCheckAtEpochMs = now + 1), now))
    }

    @Test
    fun `the builder is named, falling back to its session id when the session is gone`() {
        assertEquals("coder", TaskCard.builder(HelmPlanTask(builderSessionId = "s2", builderName = "coder")))
        assertEquals("s2", TaskCard.builder(HelmPlanTask(builderSessionId = "s2")))
        assertEquals(null, TaskCard.builder(HelmPlanTask()))
    }
}
