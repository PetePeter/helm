package com.potatomotato.helm.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RingGreetingTest {

    @Test
    fun `the opening names the topic and asks if now is a good time`() {
        assertEquals(
            "Hi, it's Helm. I have a message about P-0850 finished. Is now a good time?",
            RingGreeting.line(reason = "P-0850 finished."),
        )
    }

    @Test
    fun `a blank reason still asks`() {
        assertEquals("Hi, it's Helm. I have a message for you. Is now a good time?", RingGreeting.line(reason = " "))
    }

    @Test
    fun `a long reason is cut at a word so the opening stays short`() {
        val line = RingGreeting.line("word ".repeat(100))
        assertTrue(line.contains("…"))
        assertTrue(line.length < 160)
    }
}
