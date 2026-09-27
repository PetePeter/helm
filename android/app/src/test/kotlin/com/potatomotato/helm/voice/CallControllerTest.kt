package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The call, driven by a fake always-open microphone and a fake voice.
 *
 * Each case is a way a phone-style call goes wrong for someone who cannot look
 * at the screen: words sent twice, silence sent at all, the mic dropping between
 * sentences, Helm unable to be interrupted, or its own echo taken as the user.
 */
class CallControllerTest {
    private val mic = FakeCallMic()
    private val tts = FakeTtsEngine()
    private val sent = mutableListOf<String>()
    private var sendWorks = true
    private val controller = CallController(
        mic = mic,
        tts = tts,
        send = { text -> sent += text; sendWorks },
        sendFailedLine = SEND_FAILED,
    )

    @Test
    fun `the mic opens once and stays open across utterances`() {
        controller.start()

        mic.partial("check the")
        mic.final("check the build")
        mic.final("and run the tests")

        assertEquals(listOf("check the build", "and run the tests"), sent)
        assertEquals(1, mic.startCount)
        assertTrue(mic.open)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `an answered ring opens by speaking, with the mic already open`() {
        controller.start(opening = "Hi, it's Helm, calling about the build")

        assertEquals(listOf("Hi, it's Helm, calling about the build"), tts.spoken)
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
        assertTrue(mic.open)
    }

    @Test
    fun `a call the user starts opens silent, listening`() {
        controller.start()

        assertTrue(tts.spoken.isEmpty())
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `an empty or whitespace final is never sent`() {
        controller.start()

        mic.final("")
        mic.final("   ")

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a reply is spoken while the mic stays open`() {
        controller.start()

        controller.onReply("on it")

        assertEquals(listOf("on it"), tts.spoken)
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
        assertTrue(mic.open)

        tts.finish()

        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(1, mic.startCount)
    }

    @Test
    fun `talking over Helm stops it and what was said is sent`() {
        controller.start()
        controller.onReply("here is a long answer")
        controller.onReply("and a second line")

        mic.partial("wait stop")

        assertEquals(1, tts.stopCount)
        assertEquals(CallPhase.Listening, controller.state.value.phase)

        mic.final("wait stop that")

        assertEquals(listOf("wait stop that"), sent)
        // The queued second line was dropped with the interrupted one.
        assertEquals(listOf("here is a long answer"), tts.spoken)
    }

    @Test
    fun `a single stray word while speaking is echo, not the user`() {
        controller.start()
        controller.onReply("on it")

        mic.partial("on")
        mic.final("on")

        assertEquals(0, tts.stopCount)
        assertTrue(sent.isEmpty())
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
    }

    @Test
    fun `a late done from an interrupted line does not resume the queue`() {
        controller.start()
        controller.onReply("first")
        controller.onReply("second")
        val interruptedDone = tts.pendingDone()

        mic.partial("hold on")
        interruptedDone()

        assertEquals(listOf("first"), tts.spoken)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `replies queue behind the one being spoken, in order`() {
        controller.start()

        controller.onReply("one")
        controller.onReply("two")
        tts.finish()
        tts.finish()

        assertEquals(listOf("one", "two"), tts.spoken)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `muted means heard but not sent, and never interrupts`() {
        controller.start()
        controller.setMuted(true)
        controller.onReply("on it")

        mic.partial("private remark here")
        mic.final("private remark here")

        assertTrue(sent.isEmpty())
        assertEquals(0, tts.stopCount)
        assertEquals("", controller.state.value.heard)
    }

    @Test
    fun `a send the link cannot carry is said aloud`() {
        sendWorks = false
        controller.start()

        mic.final("status please")

        assertEquals(listOf(SEND_FAILED), tts.spoken)
    }

    @Test
    fun `hang up releases the mic and the voice, and late results are ignored`() {
        controller.start()
        controller.onReply("on it")

        controller.hangUp()
        mic.final("too late")

        assertEquals(1, mic.releaseCount)
        assertEquals(1, tts.releaseCount)
        assertFalse(mic.open)
        assertTrue(sent.isEmpty())
        assertEquals(CallPhase.Ended, controller.state.value.phase)
    }

    @Test
    fun `a mic that cannot run ends the call with an error`() {
        controller.start()

        mic.fail("no recorder")

        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(SpeechError.Audio, controller.state.value.error)
    }

    @Test
    fun `nothing is spoken before the call starts or after it ends`() {
        controller.onReply("early")
        controller.start()
        controller.hangUp()
        controller.onReply("late")

        assertTrue(tts.spoken.isEmpty())
    }

    private companion object {
        const val SEND_FAILED = "That did not send."
    }
}
