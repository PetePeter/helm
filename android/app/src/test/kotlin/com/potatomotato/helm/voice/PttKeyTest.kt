package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Test

/** The Motorola AI Key as a walkie-talkie: what each broadcast may do. */
class PttKeyTest {
    @Test
    fun `a press with no call starts a push-to-talk call to the open session, else the operator`() {
        assertEquals(PttKey.Start("s1"), PttKey.decide(down = true, liveCall = false, target = "s1"))
    }

    @Test
    fun `a press during a live call holds the mic in that call`() {
        assertEquals(PttKey.Hold(true), PttKey.decide(down = true, liveCall = true, target = "s2"))
    }

    @Test
    fun `a release always lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCall = true, target = null))
    }

    @Test
    fun `a press with nothing to call yet still brings Helm forward`() {
        // A cold process (killed in the background) knows no target until Helm is open and linked.
        assertEquals(PttKey.Open, PttKey.decide(down = true, liveCall = false, target = null))
    }


    @Test
    fun `a release before the call is published still lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCall = false, target = "s1"))
    }
}

/**
 * Android 17 MyKey: a down+up pair a few ms apart on press, and another on release.
 * The decoder rebuilds the physical hold; a real hold (one down, one late up) still works.
 */
class MyKeyPairDecoderTest {
    private val decoder = MyKeyPairDecoder()

    @Test
    fun `a classic hold passes down and up through`() {
        assertEquals(true, decoder.onBroadcast(down = true, now = 0, liveCall = false))
        assertEquals(false, decoder.onBroadcast(down = false, now = 2_000, liveCall = true))
    }

    @Test
    fun `a press pair then a release pair is one hold`() {
        assertEquals(true, decoder.onBroadcast(down = true, now = 0, liveCall = false))
        assertEquals(null, decoder.onBroadcast(down = false, now = 3, liveCall = false))
        // The call is still being placed when the key is let go: the release must not start a second call.
        assertEquals(false, decoder.onBroadcast(down = true, now = 700, liveCall = false))
        assertEquals(null, decoder.onBroadcast(down = false, now = 703, liveCall = false))
    }

    @Test
    fun `the next press pair after a full hold presses again`() {
        listOf(true to 0L, false to 3L, true to 700L, false to 703L).forEach { (d, t) ->
            decoder.onBroadcast(down = d, now = t, liveCall = true)
        }
        assertEquals(true, decoder.onBroadcast(down = true, now = 5_000, liveCall = true))
        assertEquals(null, decoder.onBroadcast(down = false, now = 5_003, liveCall = true))
    }

    @Test
    fun `a lost release pair resets once the call is over`() {
        decoder.onBroadcast(down = true, now = 0, liveCall = false)
        decoder.onBroadcast(down = false, now = 3, liveCall = false)
        // The call ended and the release pair never came: the next press starts a call, not a release.
        assertEquals(true, decoder.onBroadcast(down = true, now = 60_000, liveCall = false))
    }
}
