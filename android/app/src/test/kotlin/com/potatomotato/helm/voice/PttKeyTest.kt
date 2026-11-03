package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Test

/** The Motorola AI Key as a walkie-talkie: what each broadcast may do. */
class PttKeyTest {
    @Test
    fun `a press with no call starts a push-to-talk call to the open session, else the operator`() {
        assertEquals(PttKey.Start("s1"), PttKey.decide(down = true, liveCall = false, target = "s1", screenOn = true))
    }

    @Test
    fun `a press during a live call holds the mic in that call`() {
        assertEquals(PttKey.Hold(true), PttKey.decide(down = true, liveCall = true, target = "s2", screenOn = true))
    }

    @Test
    fun `a release always lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCall = true, target = null, screenOn = false))
    }

    @Test
    fun `a press with no session and no operator does nothing`() {
        assertEquals(PttKey.Ignore, PttKey.decide(down = true, liveCall = false, target = null, screenOn = true))
    }

    @Test
    fun `a press with the screen off cannot start a call`() {
        assertEquals(PttKey.Ignore, PttKey.decide(down = true, liveCall = false, target = "s1", screenOn = false))
    }

    @Test
    fun `a release before the call is published still lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCall = false, target = "s1", screenOn = true))
    }
}
