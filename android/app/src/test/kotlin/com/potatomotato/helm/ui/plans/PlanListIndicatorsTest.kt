package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.PlanStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlanListIndicatorsTest {
    @Test
    fun `suggested plans never show blocked even when they are not startable`() {
        assertFalse(shouldShowBlockedIndicator(PlanStatus.Suggested, "suggested", emptySet()))
    }

    @Test
    fun `non-startable unfinished plans show blocked`() {
        assertTrue(shouldShowBlockedIndicator(PlanStatus.Ready, "blocked", emptySet()))
    }
}
