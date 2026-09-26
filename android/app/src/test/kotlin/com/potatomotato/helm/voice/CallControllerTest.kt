package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The call, driven by a fake recogniser and a fake voice.
 *
 * Each case is a way a hands-free call goes wrong for someone who cannot look
 * at the screen: words sent twice, silence sent at all, Helm talking over itself
 * or hearing its own voice, a hang-up that leaves the microphone open.
 */
class CallControllerTest {
    private val speech = FakeSpeechEngine()
    private val tts = FakeTtsEngine()
    private val sent = mutableListOf<String>()
    private var sendWorks = true
    private val controller = CallController(
        speech = speech,
        tts = tts,
        send = { text -> sent += text; sendWorks },
        sendFailedLine = SEND_FAILED,
    )

    @Test
    fun `a finalised utterance is sent once and listening carries on`() {
        controller.start()

        speech.emitPartial("check the")
        speech.emitFinal("check the build")

        assertEquals(listOf("check the build"), sent)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
        // The platform closed the utterance; the call is not over, so the mic reopens.
        assertEquals(2, speech.startCount)
    }

    @Test
    fun `an empty or whitespace final is never sent`() {
        controller.start()

        speech.emitFinal("")
        speech.emitFinal("   ")

        assertTrue(sent.isEmpty())
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `a reply is spoken with the mic paused, and the mic reopens after`() {
        controller.start()

        controller.onReply("on it")

        assertEquals(listOf("on it"), tts.spoken)
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
        // Paused with cancel(), which asks for no final: Helm's own voice can
        // never come back as something the user "said".
        assertEquals(1, speech.cancelCount)
        val startsBefore = speech.startCount

        tts.finish()

        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(startsBefore + 1, speech.startCount)
    }

    @Test
    fun `a final arriving while speaking is not sent`() {
        controller.start()
        controller.onReply("on it")

        speech.emitFinal("on it")

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `there is no barge-in - a partial while speaking neither stops the voice nor is heard`() {
        controller.start()
        controller.onReply("the build is green")

        speech.emitPartial("stop")

        // The mic is paused while speaking so Helm never hears itself; a stray
        // partial from that window is not the user and must not cut the reply.
        assertEquals(0, tts.stopCount)
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
        assertEquals("", controller.state.value.heard)
    }

    @Test
    fun `replies queue and are spoken in order`() {
        controller.start()

        controller.onReply("first")
        controller.onReply("second")
        controller.onReply("third")

        assertEquals(listOf("first"), tts.spoken)
        tts.finish()
        assertEquals(listOf("first", "second"), tts.spoken)
        tts.finish()
        tts.finish()
        assertEquals(listOf("first", "second", "third"), tts.spoken)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `muted - finals are ignored`() {
        controller.start()
        controller.setMuted(true)

        speech.emitFinal("private aside")

        assertTrue(sent.isEmpty())
        assertTrue(controller.state.value.muted)

        controller.setMuted(false)
        speech.emitFinal("now send this")
        assertEquals(listOf("now send this"), sent)
    }

    @Test
    fun `hang up stops both engines and ends the call`() {
        controller.start()
        controller.onReply("talking")

        controller.hangUp()

        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(1, speech.releaseCount)
        assertEquals(1, tts.releaseCount)
        assertFalse(tts.speaking)
    }

    @Test
    fun `a reply after hanging up is not spoken`() {
        controller.start()
        controller.hangUp()

        controller.onReply("too late")

        assertTrue(tts.spoken.isEmpty())
        assertEquals(CallPhase.Ended, controller.state.value.phase)
    }

    @Test
    fun `a send that fails is spoken as a short error and listening continues`() {
        sendWorks = false
        controller.start()

        speech.emitFinal("deploy it")

        assertEquals(listOf(SEND_FAILED), tts.spoken)
        tts.finish()
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `a delivery failure reported later is spoken too`() {
        controller.start()
        speech.emitFinal("deploy it")

        controller.onSendFailed()

        assertEquals(listOf(SEND_FAILED), tts.spoken)
    }

    @Test
    fun `a silence timeout keeps the call listening`() {
        controller.start()

        speech.emitError(SpeechError.NoMatch)

        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(2, speech.startCount)
    }

    @Test
    fun `no match after partials sends what was heard and keeps listening`() {
        controller.start()

        speech.emitPartial("check the build")
        speech.emitError(SpeechError.NoMatch)

        assertEquals(listOf("check the build"), sent)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(2, speech.startCount)
    }

    @Test
    fun `no match after partials while muted sends nothing`() {
        controller.start()
        controller.setMuted(true)

        speech.emitPartial("private words")
        speech.emitError(SpeechError.NoMatch)

        assertTrue(sent.isEmpty())
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `a denied microphone ends the call rather than looping`() {
        controller.start()

        speech.emitError(SpeechError.PermissionDenied)

        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(SpeechError.PermissionDenied, controller.state.value.error)
    }

    private companion object {
        const val SEND_FAILED = "That did not send."
    }
}
