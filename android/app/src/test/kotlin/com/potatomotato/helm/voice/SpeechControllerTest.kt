package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The voice state machine, driven by a fake recogniser.
 *
 * Everything asserted here is a way the screen can strand or mislead the user:
 * text that grows instead of being replaced, a transcript lost to a stumble, a
 * spinner that never stops saying "Listening". The mic button's size and the
 * waveform bars are deliberately not tested — they carry no decision.
 */
class SpeechControllerTest {
    private val engine = FakeSpeechEngine()
    private val controller = SpeechController(engine)

    @Test
    fun `partial results replace the transcript rather than accumulating`() {
        controller.start()

        engine.emitPartial("test")
        engine.emitPartial("test test")
        engine.emitPartial("test test test")

        // The classic bug is appending each partial, which turns one spoken
        // phrase into "test test test test test test". Each partial is the
        // recogniser's whole current guess, not a delta.
        assertEquals("test test test", controller.state.value.transcript)
        assertEquals(VoicePhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `a final result supersedes the last partial and ends listening`() {
        controller.start()
        engine.emitPartial("surface it and let the")

        controller.stop()
        engine.emitFinal("surface it and let the app retry")

        val state = controller.state.value
        assertEquals("surface it and let the app retry", state.transcript)
        assertEquals(VoicePhase.Captured, state.phase)
        assertNull(state.error)
    }

    @Test
    fun `a final while still holding continues listening and keeps the mic open`() {
        // THE pause fix: the platform closes the utterance on its own
        // end-of-speech silence while the finger is still down. Ending the
        // dictation there captured half a thought and left a dead mic; the
        // utterance restarts and the dictation carries on instead.
        controller.start()
        engine.emitPartial("surface it and let the")

        engine.emitFinal("surface it and let the app retry")

        val state = controller.state.value
        assertEquals("surface it and let the app retry", state.transcript)
        assertEquals(VoicePhase.Listening, state.phase)
        assertEquals(2, engine.startCount)
    }

    @Test
    fun `segments across a held pause join into one transcript`() {
        // Pause mid-hold (platform final), resume into the restarted utterance,
        // then release: the stop's final covers only the resumed segment.
        controller.start()
        engine.emitPartial("first part")
        engine.emitFinal("first part")

        engine.emitPartial("second part")

        controller.stop()
        engine.emitFinal("second part")

        val state = controller.state.value
        assertEquals(VoicePhase.Captured, state.phase)
        assertEquals("first part second part", state.transcript)
    }

    @Test
    fun `releasing right after a held pause captures the committed segments`() {
        controller.start()
        engine.emitPartial("the whole thought")
        engine.emitFinal("the whole thought")

        controller.stop()
        // The restarted utterance heard nothing before the release; its final
        // comes back blank and must not disturb what was already committed.
        engine.emitFinal("")

        val state = controller.state.value
        assertEquals(VoicePhase.Captured, state.phase)
        assertEquals("the whole thought", state.transcript)
    }

    @Test
    fun `a restart after a held pause replaces only the new segment, not the committed text`() {
        controller.start()
        engine.emitPartial("committed words")
        engine.emitFinal("committed words")

        engine.emitPartial("new guess")

        assertEquals("committed words new guess", controller.state.value.transcript)
    }

    @Test
    fun `a new press still means say it differently, not add to it`() {
        controller.start()
        engine.emitPartial("first attempt")
        controller.stop()
        engine.emitFinal("first attempt")

        controller.start()

        // The committed segments belong to the PREVIOUS hold; a fresh press
        // starts the dictation over.
        assertEquals(VoicePhase.Listening, controller.state.value.phase)
        engine.emitPartial("second attempt")
        assertEquals("second attempt", controller.state.value.transcript)
    }

    @Test
    fun `a blank final keeps what was already heard instead of wiping it`() {
        controller.start()
        engine.emitPartial("deploy the release build")

        controller.stop()
        // Some recognisers close an utterance with an empty final. Trusting it
        // would delete a transcript the user watched appear.
        engine.emitFinal("")

        assertEquals("deploy the release build", controller.state.value.transcript)
        assertEquals(VoicePhase.Captured, controller.state.value.phase)
    }

    @Test
    fun `a blank final while holding restarts listening without failing`() {
        controller.start()

        engine.emitFinal("")

        // Nothing was heard yet, but the finger is down: a restart, not a
        // failure — the user is still thinking.
        assertEquals(VoicePhase.Listening, controller.state.value.phase)
        assertEquals(2, engine.startCount)
    }

    @Test
    fun `a final with nothing heard at all reports no match rather than capturing emptiness`() {
        controller.start()

        controller.stop()
        engine.emitFinal("   ")

        val state = controller.state.value
        assertEquals(VoicePhase.Failed, state.phase)
        assertEquals(SpeechError.NoMatch, state.error)
        assertEquals("", state.transcript)
    }

    @Test
    fun `a silence timeout while holding restarts listening instead of failing`() {
        controller.start()
        engine.emitPartial("kept words")
        engine.emitFinal("kept words")

        engine.emitError(SpeechError.NoMatch)

        val state = controller.state.value
        assertEquals(VoicePhase.Listening, state.phase)
        assertEquals("kept words", state.transcript)
        assertEquals(3, engine.startCount)
    }

    @Test
    fun `a busy recognizer while holding restarts listening instead of failing`() {
        controller.start()

        engine.emitError(SpeechError.Busy)

        assertEquals(VoicePhase.Listening, controller.state.value.phase)
        assertEquals(2, engine.startCount)
    }

    @Test
    fun `a network error while holding still fails — restarting cannot fix a missing language pack`() {
        controller.start()
        engine.emitPartial("offline attempt")

        engine.emitError(SpeechError.Network)

        val state = controller.state.value
        assertEquals(VoicePhase.Failed, state.phase)
        assertEquals(SpeechError.Network, state.error)
        assertEquals(1, engine.startCount)
    }

    @Test
    fun `an error mid-utterance leaves a recoverable state, never stuck listening`() {
        controller.start()
        engine.emitPartial("check the framing vectors")

        engine.emitError(SpeechError.Audio)

        val state = controller.state.value
        assertEquals(VoicePhase.Failed, state.phase)
        assertEquals(SpeechError.Audio, state.error)
        // What was already heard survives: voice input is expensive to redo.
        assertEquals("check the framing vectors", state.transcript)
    }

    @Test
    fun `starting again after a failure clears the previous error`() {
        controller.start()
        engine.emitError(SpeechError.Network)

        controller.start()

        val state = controller.state.value
        assertEquals(VoicePhase.Listening, state.phase)
        assertNull(state.error)
        assertEquals(2, engine.startCount)
    }

    @Test
    fun `a second start while already listening does not re-register the engine`() {
        controller.start()
        engine.emitPartial("already going")

        controller.start()

        // Re-registering would double every subsequent callback and, on the real
        // recogniser, cancel the utterance in flight.
        assertEquals(1, engine.startCount)
        assertEquals("already going", controller.state.value.transcript)
    }

    @Test
    fun `cancelling discards the transcript and asks the engine to abandon the utterance`() {
        controller.start()
        engine.emitPartial("forget this")

        controller.cancel()

        val state = controller.state.value
        assertEquals(VoicePhase.Idle, state.phase)
        assertEquals("", state.transcript)
        assertEquals(1, engine.cancelCount)
        // cancel(), not stop(): stop() would ask for a final result for text the
        // user has just thrown away.
        assertEquals(0, engine.stopCount)
    }

    @Test
    fun `a late callback after cancelling is ignored`() {
        controller.start()
        controller.cancel()

        // The platform recogniser keeps delivering for a beat after cancel().
        engine.emitPartial("ghost text")
        engine.emitFinal("ghost text")

        assertEquals("", controller.state.value.transcript)
        assertEquals(VoicePhase.Idle, controller.state.value.phase)
    }

    @Test
    fun `stopping asks for a final result, and does nothing when not listening`() {
        controller.stop()
        assertEquals(0, engine.stopCount)

        controller.start()
        controller.stop()
        assertEquals(1, engine.stopCount)

        // Still listening until the final actually lands — stopping is a request.
        assertEquals(VoicePhase.Listening, controller.state.value.phase)
        engine.emitFinal("done talking")
        assertEquals(VoicePhase.Captured, controller.state.value.phase)
    }

    @Test
    fun `the level meter only moves while listening`() {
        controller.start()
        engine.emitLevel(0.8f)
        assertEquals(0.8f, controller.state.value.level, TOLERANCE)

        controller.stop()
        engine.emitFinal("said something")

        // A meter left twitching under captured text reads as "still recording".
        assertEquals(0f, controller.state.value.level, TOLERANCE)
    }

    @Test
    fun `retrying is offered for a stumble but never for a denied permission`() {
        // Retrying a permission denial re-runs a request the system will refuse
        // without a prompt; the screen has to send the user to Settings instead.
        assertFalse(SpeechError.PermissionDenied.retryable)
        assertFalse(SpeechError.NoSpeechService.retryable)
        assertTrue(SpeechError.NoMatch.retryable)
        assertTrue(SpeechError.Audio.retryable)
        assertTrue(SpeechError.Network.retryable)
    }

    @Test
    fun `releasing abandons any utterance in flight`() {
        controller.start()
        engine.emitPartial("half a sentence")

        controller.release()

        // Leaving the screen must not leave the microphone held open.
        assertEquals(1, engine.releaseCount)
        assertEquals(VoicePhase.Idle, controller.state.value.phase)
    }

    @Test
    fun `an unavailable offline language reads as no language pack, not as an unknown failure`() {
        // Found on-device: the audit tablet's recogniser starts, then reports
        // code 13 (ERROR_LANGUAGE_UNAVAILABLE — no downloaded language pack)
        // within 200ms. Generic "Recognition failed" hid a diagnosis the user
        // could act on; Network says the honest thing about the offline path.
        assertEquals(SpeechError.Network, speechErrorOf(13))
        assertEquals(SpeechError.Network, speechErrorOf(12))
    }

    @Test
    fun `every other platform code keeps its meaning`() {
        assertEquals(SpeechError.Network, speechErrorOf(1))
        assertEquals(SpeechError.Network, speechErrorOf(2))
        assertEquals(SpeechError.Audio, speechErrorOf(3))
        assertEquals(SpeechError.NoSpeechService, speechErrorOf(4))
        assertEquals(SpeechError.Audio, speechErrorOf(5))
        assertEquals(SpeechError.NoMatch, speechErrorOf(6))
        assertEquals(SpeechError.NoMatch, speechErrorOf(7))
        assertEquals(SpeechError.Busy, speechErrorOf(8))
        assertEquals(SpeechError.PermissionDenied, speechErrorOf(9))
        // A code a future Android invents degrades to Unknown, never crashes.
        assertEquals(SpeechError.Unknown, speechErrorOf(99))
    }
}

private const val TOLERANCE = 0.0001f
