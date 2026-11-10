package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuotaResetFormatTest {
    private val now = 1_794_340_000_000L
    private val min = 60_000L

    @Test
    fun formatsLikeTheDesktopCard() {
        assertEquals("resets in 3h 12m", formatQuotaResetIn(now + (3 * 60 + 12) * min, now))
        assertEquals("resets in 6d 4h", formatQuotaResetIn(now + ((6 * 24 + 4) * 60 + 30) * min, now))
        assertEquals("resets in 41m", formatQuotaResetIn(now + 41 * min, now))
        assertEquals("resets in <1m", formatQuotaResetIn(now + 20_000L, now))
    }

    @Test
    fun hidesAPassedReset() {
        assertNull(formatQuotaResetIn(now, now))
        assertNull(formatQuotaResetIn(now - min, now))
    }
}
