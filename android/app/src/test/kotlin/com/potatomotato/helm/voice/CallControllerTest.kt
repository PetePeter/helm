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
    private val line = FakeCallLine()
    private val micSwitch = FakeMicSwitch()
    private val sent = mutableListOf<String>()
    private var sendWorks = true
    private val controller = CallController(
        mic = mic,
        tts = tts,
        send = { text -> sent += text; sendWorks },
        sendFailedLine = SEND_FAILED,
        line = line,
        micSwitch = micSwitch,
    )

    /** A call the user starts, once Android's call system has taken it. */
    private fun dial() {
        controller.start()
        line.connect()
    }

    @Test
    fun `the mic opens once and stays open across utterances`() {
        dial()

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
        dial()

        assertTrue(tts.spoken.isEmpty())
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `an empty or whitespace final is never sent`() {
        dial()

        mic.final("")
        mic.final("   ")

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a reply is spoken while the mic stays open`() {
        dial()

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
        dial()
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
        dial()
        controller.onReply("on it")

        mic.partial("on")
        mic.final("on")

        assertEquals(0, tts.stopCount)
        assertTrue(sent.isEmpty())
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
    }

    @Test
    fun `a late done from an interrupted line does not resume the queue`() {
        dial()
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
        dial()

        controller.onReply("one")
        controller.onReply("two")
        tts.finish()
        tts.finish()

        assertEquals(listOf("one", "two"), tts.spoken)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `muted means nothing is sent, and never interrupts`() {
        dial()
        controller.setMuted(true)
        controller.onReply("on it")

        mic.partial("private remark here")
        mic.final("private remark here")

        assertTrue(sent.isEmpty())
        assertEquals(0, tts.stopCount)
        assertEquals("", controller.state.value.heard)
    }

    @Test
    fun `the Mute button flips the phone's own microphone mute`() {
        dial()

        controller.setMuted(true)

        assertTrue(micSwitch.muted)
        assertTrue(controller.state.value.muted)

        controller.setMuted(false)

        assertFalse(micSwitch.muted)
        assertFalse(controller.state.value.muted)
    }

    @Test
    fun `a mute from the car or the system mutes the call, and unmuting resumes sending`() {
        dial()

        micSwitch.muted = true
        controller.syncMute()
        mic.final("not for helm")

        assertTrue(controller.state.value.muted)
        assertTrue(sent.isEmpty())

        micSwitch.muted = false
        controller.syncMute()
        mic.final("check the build")

        assertFalse(controller.state.value.muted)
        assertEquals(listOf("check the build"), sent)
    }

    @Test
    fun `the system repeating a mute it was already told about changes nothing`() {
        dial()
        controller.setMuted(true)
        controller.setMuted(false)
        mic.partial("check the")

        // Telecom reports audio state on every route change too, not only on mute.
        controller.syncMute()
        controller.syncMute()

        assertFalse(controller.state.value.muted)
        assertFalse(micSwitch.muted)
        assertEquals("check the", controller.state.value.heard)
    }

    @Test
    fun `a call that ends muted hands the microphone back unmuted`() {
        dial()
        controller.setMuted(true)

        controller.hangUp()

        assertFalse(micSwitch.muted)
    }

    @Test
    fun `mute before the call is up or after it ends never touches the microphone`() {
        controller.start()
        controller.setMuted(true)

        assertFalse(micSwitch.muted)

        line.connect()
        controller.hangUp()
        controller.setMuted(true)

        assertFalse(micSwitch.muted)
    }

    @Test
    fun `a call the user starts waits for Android's call system before opening the mic`() {
        controller.start()

        assertEquals(1, line.placeCount)
        assertEquals(0, mic.startCount)
        assertEquals(CallPhase.Idle, controller.state.value.phase)

        line.connect()

        assertEquals(1, mic.startCount)
        assertEquals(1, line.activeCount)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
    }

    @Test
    fun `a call the system refuses never starts, and says why`() {
        line.refusal = CallRefusal.Busy

        controller.start()

        assertEquals(0, mic.startCount)
        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(CallRefusal.Busy, controller.state.value.refused)
    }

    @Test
    fun `a call the system takes and then fails to create never starts either`() {
        controller.start()

        line.fail()

        assertEquals(0, mic.startCount)
        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(CallRefusal.Unavailable, controller.state.value.refused)
        assertEquals(1, line.endCount)
    }

    @Test
    fun `hanging up while still connecting ends the system call, and a late answer opens nothing`() {
        controller.start()

        controller.hangUp()
        line.connect()

        assertEquals(1, line.endCount)
        assertEquals(0, mic.startCount)
        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(null, controller.state.value.refused)
    }

    @Test
    fun `an answered ring is already a system call, so it opens at once`() {
        controller.start(opening = "Hi, it's Helm")

        assertEquals(0, line.placeCount)
        assertEquals(1, line.activeCount)
        assertEquals(1, mic.startCount)
    }

    @Test
    fun `the system call ends with ours, once, however many times hang up arrives`() {
        dial()

        // The car hangs up, which hangs up our call, which ends the system call.
        controller.hangUp()
        controller.hangUp()

        assertEquals(1, line.endCount)
        assertEquals(1, mic.releaseCount)
    }

    @Test
    fun `a send the link cannot carry is said aloud`() {
        sendWorks = false
        dial()

        mic.final("status please")

        assertEquals(listOf(SEND_FAILED), tts.spoken)
    }

    @Test
    fun `hang up releases the mic and the voice, and late results are ignored`() {
        dial()
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
        dial()

        mic.fail("no recorder")

        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(SpeechError.Audio, controller.state.value.error)
    }

    @Test
    fun `nothing is spoken before the call starts or after it ends`() {
        controller.onReply("early")
        dial()
        controller.hangUp()
        controller.onReply("late")

        assertTrue(tts.spoken.isEmpty())
    }

    private companion object {
        const val SEND_FAILED = "That did not send."
    }
}
