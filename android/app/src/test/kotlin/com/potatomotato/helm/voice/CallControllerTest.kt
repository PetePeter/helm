package com.potatomotato.helm.voice

import com.potatomotato.helm.wire.MobileCallInterruption
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
    private val sentInterruptions = mutableListOf<MobileCallInterruption?>()
    private var sendWorks = true
    private val turnTimer = FakeTurnTimer()
    private var clock = 0L
    private val controller = CallController(
        mic = mic,
        tts = tts,
        send = { text, interruption ->
            sent += text
            sentInterruptions += interruption
            sendWorks
        },
        sendFailedLine = SEND_FAILED,
        line = line,
        micSwitch = micSwitch,
        turnTimer = turnTimer,
        now = { clock },
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
    fun `a normally completed reply adds no interruption to the next user message`() {
        dial()
        controller.onReply("That reply finished.")
        tts.finish()
        mic.final("thanks")

        assertEquals(listOf("thanks"), sent)
        assertEquals(listOf(null), sentInterruptions)
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
    fun `a sent barge-in carries the active reply offset and every dropped queued reply`() {
        dial()
        val reply = "First sentence. The second sentence was interrupted here. The third sentence follows."
        controller.onReply(reply)
        controller.onReply("queued reply one")
        controller.onReply("queued reply two")
        val offset = reply.indexOf("interrupted")
        tts.advanceProgress(offset)

        mic.partial("please wait")
        mic.final("please wait a moment")

        assertEquals(listOf("please wait a moment"), sent)
        assertEquals(
            listOf(MobileCallInterruption(reply, offset, listOf("queued reply one", "queued reply two"))),
            sentInterruptions,
        )
        assertEquals(listOf(reply), tts.spoken)
    }

    @Test
    fun `a barge-in without spoken progress carries the full active and queued replies`() {
        dial()
        controller.onReply("Unmeasured reply.")
        controller.onReply("Queued reply.")

        mic.partial("please stop")
        mic.final("please stop")

        assertEquals(
            listOf(MobileCallInterruption("Unmeasured reply.", null, listOf("Queued reply."))),
            sentInterruptions,
        )
    }

    @Test
    fun `an interrupted reply is not attached when no non-empty final is sent`() {
        dial()
        controller.onReply("A reply that gets cut off.")
        tts.advanceProgress(0)

        mic.partial("please stop")
        mic.final("")

        assertTrue(sent.isEmpty())
        assertTrue(sentInterruptions.isEmpty())
    }

    @Test
    fun `a single stray word while speaking is echo, not the user`() {
        dial()
        controller.onReply("on it")

        mic.partial("on")
        mic.final("on")

        assertEquals(0, tts.stopCount)
        assertTrue(sent.isEmpty())
        assertTrue(sentInterruptions.isEmpty())
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
    fun `push-to-talk sends only what is said while the key is held`() {
        dial()
        controller.setMicMode(MicMode.PushToTalk)
        assertTrue(micSwitch.muted)
        mic.final("not for helm")

        controller.setPttKeyHeld(true)
        assertFalse(micSwitch.muted)
        mic.final("check the build")

        controller.setPttKeyHeld(false)
        assertTrue(micSwitch.muted)
        mic.final("nor this")

        assertEquals(listOf("check the build"), sent)
        assertEquals(MicMode.PushToTalk, controller.state.value.micMode)
    }

    @Test
    fun `a call started in push-to-talk opens the mic only while the key is held`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        assertEquals(MicMode.PushToTalk, controller.state.value.micMode)
        assertFalse(micSwitch.muted)
        mic.final("check the build")

        controller.setPttKeyHeld(false)
        assertTrue(micSwitch.muted)
        mic.final("not this")

        assertEquals(listOf("check the build"), sent)
    }

    @Test
    fun `a key released before the call connects leaves the mic muted`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        controller.setPttKeyHeld(false)
        line.connect()

        assertTrue(micSwitch.muted)
        assertFalse(controller.state.value.pttHeld)
    }

    @Test
    fun `a pause while the key is held sends nothing, the release sends it all as one`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        mic.final("check the build")
        mic.final("and run the tests")
        assertTrue(sent.isEmpty())

        controller.setPttKeyHeld(false)
        assertEquals(listOf("check the build and run the tests"), sent)
    }

    @Test
    fun `the release joins held finals with the words not yet finalised`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        mic.final("check the build")
        mic.partial("then deploy")
        controller.setPttKeyHeld(false)
        mic.final("then deploy")

        assertEquals(listOf("check the build then deploy"), sent)
    }

    @Test
    fun `hanging up with the key held sends nothing`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        mic.final("check the build")
        controller.hangUp()

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `releasing the key sends what was heard before the recogniser finalised it`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        mic.partial("check the build")
        controller.setPttKeyHeld(false)
        mic.final("check the build")

        assertEquals(listOf("check the build"), sent)
    }

    @Test
    fun `words finalised while held are not sent again on release`() {
        controller.start(micMode = MicMode.PushToTalk)
        controller.setPttKeyHeld(true)
        line.connect()

        mic.partial("check the")
        mic.final("check the build")
        controller.setPttKeyHeld(false)

        assertEquals(listOf("check the build"), sent)
    }

    @Test
    fun `pressing the talk key stops Helm reading and the next words carry the interruption`() {
        controller.start(micMode = MicMode.PushToTalk)
        line.connect()
        controller.onReply("the build is green and the tests pass")

        controller.setPttKeyHeld(true)

        assertFalse(tts.speaking)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
        mic.final("stop, try again")
        controller.setPttKeyHeld(false)
        assertEquals(listOf("stop, try again"), sent)
        assertTrue(sentInterruptions.single() != null)
    }

    @Test
    fun `a call is idle only while nobody can talk and nothing is read`() {
        controller.start(micMode = MicMode.PushToTalk)
        line.connect()
        assertTrue(controller.state.value.idle)

        controller.setPttKeyHeld(true)
        assertFalse(controller.state.value.idle)
        controller.setPttKeyHeld(false)

        controller.onReply("the build is green")
        assertFalse(controller.state.value.idle)
        tts.finish()
        assertTrue(controller.state.value.idle)

        controller.setMicMode(MicMode.Open)
        assertFalse(controller.state.value.idle)
    }

    @Test
    fun `a reply is read aloud while the push-to-talk mic is muted`() {
        controller.start(micMode = MicMode.PushToTalk)
        line.connect()

        controller.onReply("build is green")

        assertTrue(micSwitch.muted)
        assertEquals(listOf("build is green"), tts.spoken)
    }

    @Test
    fun `an unmute from the car cannot open a push-to-talk mic`() {
        dial()
        controller.setMicMode(MicMode.PushToTalk)

        micSwitch.muted = false
        controller.syncMute()

        assertTrue(micSwitch.muted)
        assertTrue(controller.state.value.muted)
        assertEquals(MicMode.PushToTalk, controller.state.value.micMode)
    }

    @Test
    fun `a mic mode picked on screen sticks, the talk key does nothing outside push-to-talk`() {
        dial()
        controller.setMuted(true)

        controller.setPttKeyHeld(true)

        assertTrue(micSwitch.muted)
        assertFalse(controller.state.value.pttHeld)
    }

    @Test
    fun `leaving push-to-talk mid-press drops the press`() {
        dial()
        controller.setMicMode(MicMode.PushToTalk)
        controller.setPttKeyHeld(true)

        controller.setMicMode(MicMode.Muted)

        assertTrue(micSwitch.muted)
        assertFalse(controller.state.value.pttHeld)
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

    @Test
    fun `finals separated by short pauses are sent as one turn once the user goes quiet`() {
        turnTimer.immediate = false
        dial()

        clock = 1_000
        mic.final("check the build")
        clock = 1_800
        mic.partial("and run")
        clock = 3_000
        mic.final("and run the tests")
        assertTrue(sent.isEmpty())

        turnTimer.elapse()

        assertEquals(listOf("check the build [pause 0.8s] and run the tests"), sent)
    }

    @Test
    fun `speech resumed before the hold runs out keeps the turn open`() {
        turnTimer.immediate = false
        dial()

        mic.final("check the build")
        assertTrue(turnTimer.isArmed)
        mic.partial("and")

        assertFalse(turnTimer.isArmed)
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a reply that arrives mid-turn waits until the turn is sent`() {
        turnTimer.immediate = false
        dial()

        mic.partial("check the")
        controller.onReply("On it")
        assertTrue(tts.spoken.isEmpty())

        mic.final("check the build")
        controller.onReply("Still on it")
        assertTrue(tts.spoken.isEmpty())

        turnTimer.elapse()

        assertEquals(listOf("check the build"), sent)
        assertEquals(listOf("On it"), tts.spoken)
        assertEquals(CallPhase.Speaking, controller.state.value.phase)
    }

    @Test
    fun `muting sends the turn already heard`() {
        turnTimer.immediate = false
        dial()

        mic.final("check the build")
        controller.setMuted(true)

        assertEquals(listOf("check the build"), sent)
        assertFalse(turnTimer.isArmed)
    }

    @Test
    fun `hanging up drops an unsent turn`() {
        turnTimer.immediate = false
        dial()

        mic.final("check the build")
        controller.hangUp()
        turnTimer.elapse()

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a barge-in report rides on the stitched turn`() {
        turnTimer.immediate = false
        dial()
        controller.onReply("Here is a long answer")

        mic.partial("wait stop")
        mic.final("wait stop")
        mic.final("")
        mic.final("do the other thing")
        turnTimer.elapse()

        assertEquals(1, sent.size)
        assertEquals("Here is a long answer", sentInterruptions.single()?.text)
    }
}
