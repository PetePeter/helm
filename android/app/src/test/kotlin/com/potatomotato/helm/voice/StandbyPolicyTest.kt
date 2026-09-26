package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Regression: the mic re-armed after hang-up and could not be switched off. */
class StandbyPolicyTest {
    @Test
    fun `a call ending with Hey Helm off stops`() {
        assertNull(StandbyPolicy.resumeAfter(heyHelmOn = false, target = "s1"))
    }

    @Test
    fun `a call ending with Hey Helm on goes back to standby`() {
        assertEquals("s1", StandbyPolicy.resumeAfter(heyHelmOn = true, target = "s1"))
    }

    @Test
    fun `nobody to listen for stops`() {
        assertNull(StandbyPolicy.resumeAfter(heyHelmOn = true, target = null))
    }
}
