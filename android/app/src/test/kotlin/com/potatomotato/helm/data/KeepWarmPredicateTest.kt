package com.potatomotato.helm.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepWarmPredicateTest {
    @Test
    fun `keep warm is enabled only for a future timestamp`() {
        val nowMs = 1_000L

        assertFalse(isKeepWarmEnabled(untilEpochMs = null, nowMs = nowMs))
        assertFalse(isKeepWarmEnabled(untilEpochMs = 999L, nowMs = nowMs))
        assertFalse(isKeepWarmEnabled(untilEpochMs = nowMs, nowMs = nowMs))
        assertTrue(isKeepWarmEnabled(untilEpochMs = 1_001L, nowMs = nowMs))
    }
}
