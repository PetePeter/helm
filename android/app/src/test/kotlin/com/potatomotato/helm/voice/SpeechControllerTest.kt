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

        engine.emitFinal("surface it and let the app retry")

        val state = controller.state.value
        assertEquals("surface it and let the app retry", state.transcript)
        assertEquals(VoicePhase.Captured, state.phase)
        assertNull(state.error)
    }

    @Test
    fun `a blank final keeps what was already heard instead of wiping it`() {
        controller.start()
        engine.emitPartial("deploy the release build")

        // Some recognisers close an utterance with an empty final. Trusting it
        // would delete a transcript the user watched appear.
        engine.emitFinal("")

        assertEquals("deploy the release build", controller.state.value.transcript)
        assertEquals(VoicePhase.Captured, controller.state.value.phase)
    }

    @Test
    fun `a final with nothing heard at all reports no match rather than capturing emptiness`() {
        controller.start()

        engine.emitFinal("   ")

        val state = controller.state.value
        assertEquals(VoicePhase.Failed, state.phase)
        assertEquals(SpeechError.NoMatch, state.error)
        assertEquals("", state.transcript)
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

        engine.emitFinal("said something")

        // A meter left twitching under captured text reads as "still recording".
        assertEquals(0f, controller.state.value.level, TOLERANCE)
    }

    @Test
    fun `editing the transcript keeps it captured and ready to send`() {
        controller.start()
        engine.emitFinal("send the plan to teh session")

        controller.edit("send the plan to the session")

        val state = controller.state.value
        assertEquals("send the plan to the session", state.transcript)
        assertEquals(VoicePhase.Captured, state.phase)
    }

    @Test
    fun `clearing an edited transcript drops back out of the captured state`() {
        controller.start()
        engine.emitFinal("everything")

        controller.edit("")

        // Nothing to send, so the screen must not keep offering Send.
        assertEquals(VoicePhase.Idle, controller.state.value.phase)
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
