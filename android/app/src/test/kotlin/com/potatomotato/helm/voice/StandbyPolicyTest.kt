package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Regression: the mic re-armed after hang-up and could not be switched off. */
class StandbyPolicyTest {
    @Test
    fun `a call ending with Hey Helm off stops`() {
        assertNull(StandbyPolicy.resumeAfter(wasStandby = false, heyHelmOn = false, target = "s1"))
    }

    @Test
    fun `standby ending after the switch goes off stops`() {
        assertNull(StandbyPolicy.resumeAfter(wasStandby = true, heyHelmOn = false, target = "s1"))
    }

    @Test
    fun `standby never resumes itself even with the switch on`() {
        assertNull(StandbyPolicy.resumeAfter(wasStandby = true, heyHelmOn = true, target = "s1"))
    }

    @Test
    fun `a call ending with Hey Helm on goes back to standby`() {
        assertEquals("s1", StandbyPolicy.resumeAfter(wasStandby = false, heyHelmOn = true, target = "s1"))
    }

    @Test
    fun `nobody to listen for stops`() {
        assertNull(StandbyPolicy.resumeAfter(wasStandby = false, heyHelmOn = true, target = null))
    }
}
