package com.potatomotato.helm.ui.pairing

import org.junit.Assert.assertEquals
import org.junit.Test

class ElapsedFormatTest {
    @Test
    fun `seconds under a minute keep the zero-padded seconds field`() {
        assertEquals("0:00", formatElapsed(0))
        assertEquals("0:09", formatElapsed(9))
        assertEquals("0:45", formatElapsed(45))
    }

    @Test
    fun `a minute rolls the minutes field over without dropping the pad`() {
        assertEquals("1:00", formatElapsed(60))
        assertEquals("1:05", formatElapsed(65))
        assertEquals("2:30", formatElapsed(150))
    }

    @Test
    fun `a negative reading clamps to zero rather than printing a sign`() {
        assertEquals("0:00", formatElapsed(-5))
    }
}
