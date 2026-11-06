package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnStitcherTest {
    private val turn = TurnStitcher()

    @Test
    fun `finals join with the pause before each one written inline`() {
        turn.add("check the build", at = 1_000)
        turn.speech(at = 1_800)
        turn.speech(at = 2_200) // Later partials do not move where the pause ended.
        turn.add("and run the tests", at = 3_000)

        assertEquals("check the build [pause 0.8s] and run the tests", turn.take())
    }

    @Test
    fun `a gap shorter than a real pause is joined unmarked`() {
        turn.add("check", at = 1_000)
        turn.speech(at = 1_200)
        turn.add("the build", at = 2_000)

        assertEquals("check the build", turn.take())
    }

    @Test
    fun `without a speech mark the gap runs to the final`() {
        turn.add("one", at = 0)
        turn.add("two", at = 1_500)

        assertEquals("one [pause 1.5s] two", turn.take())
    }

    @Test
    fun `take starts a fresh turn`() {
        turn.add("first", at = 0)
        turn.take()

        assertFalse(turn.pending)
        turn.speech(at = 500) // Speech with nothing pending marks nothing.
        turn.add("second", at = 5_000)
        assertTrue(turn.pending)
        assertEquals("second", turn.take())
    }
}
