package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Test

/** The Motorola AI Key as a walkie-talkie: what each broadcast may do. */
class PttKeyTest {
    @Test
    fun `a press with no call starts a push-to-talk call to the open session, else the operator`() {
        assertEquals(PttKey.Start("s1"), PttKey.decide(down = true, liveCallTarget = null, target = "s1"))
    }

    @Test
    fun `a press during a live call retargets to the newly selected session`() {
        assertEquals(
            PttKey.Retarget("s2"),
            PttKey.decide(down = true, liveCallTarget = "s1", target = "s2"),
        )
    }

    @Test
    fun `a press from the session list during a live call keeps the call, never the operator fallback`() {
        assertEquals(
            PttKey.Hold(true),
            PttKey.decide(down = true, liveCallTarget = "s1", target = "operator", openSession = null),
        )
    }

    @Test
    fun `a press during a live call on the selected session holds its mic`() {
        assertEquals(PttKey.Hold(true), PttKey.decide(down = true, liveCallTarget = "s2", target = "s2"))
    }

    @Test
    fun `a release always lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCallTarget = "s1", target = null))
    }

    @Test
    fun `a press with nothing to call yet still brings Helm forward`() {
        // A cold process (killed in the background) knows no target until Helm is open and linked.
        assertEquals(PttKey.Open, PttKey.decide(down = true, liveCallTarget = null, target = null))
    }


    @Test
    fun `a release before the call is published still lets go of the mic`() {
        assertEquals(PttKey.Hold(false), PttKey.decide(down = false, liveCallTarget = null, target = "s1"))
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
    fun `a press pair then a lone late release up lets go and the next press starts`() {
        // Seen on the device: press = down+up 2 ms apart, release = a lone up seconds later.
        assertEquals(true, decoder.onBroadcast(down = true, now = 0, liveCall = false))
        assertEquals(null, decoder.onBroadcast(down = false, now = 2, liveCall = false))
        assertEquals(false, decoder.onBroadcast(down = false, now = 5_000, liveCall = true))
        assertEquals(true, decoder.onBroadcast(down = true, now = 8_000, liveCall = false))
        assertEquals(null, decoder.onBroadcast(down = false, now = 8_002, liveCall = false))
        assertEquals(false, decoder.onBroadcast(down = false, now = 9_500, liveCall = true))
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
    fun `the next press pair reaches PttKey and retargets after selection changes`() {
        listOf(true to 0L, false to 3L, true to 700L, false to 703L).forEach { (d, t) ->
            decoder.onBroadcast(down = d, now = t, liveCall = true)
        }
        val down = decoder.onBroadcast(down = true, now = 5_000, liveCall = true)
        assertEquals(true, down)
        assertEquals(null, decoder.onBroadcast(down = false, now = 5_003, liveCall = true))
        assertEquals(
            PttKey.Retarget("s2"),
            PttKey.decide(down = down == true, liveCallTarget = "s1", target = "s2"),
        )
    }

    @Test
    fun `a lost release pair resets once the call is over`() {
        decoder.onBroadcast(down = true, now = 0, liveCall = false)
        decoder.onBroadcast(down = false, now = 3, liveCall = false)
        // The call ended and the release pair never came: the next press starts a call, not a release.
        assertEquals(true, decoder.onBroadcast(down = true, now = 60_000, liveCall = false))
    }
}
