package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Hey Helm" standby: the same controller, listening for the wake phrase.
 *
 * One question, one spoken answer, back to standby — and nothing else from the
 * target is read out, because a phone on the kitchen bench must not narrate a
 * whole session to the room.
 */
class StandbyControllerTest {
    private val speech = FakeSpeechEngine()
    private val tts = FakeTtsEngine()
    private val timer = FakeTimer()
    private val sent = mutableListOf<String>()
    private var sendWorks = true
    private var cues = 0
    private val controller = CallController(
        speech = speech,
        tts = tts,
        send = { text -> sent += text; sendWorks },
        sendFailedLine = SEND_FAILED,
        standby = Standby(
            onWake = { cues++ },
            yesLine = YES,
            stillWaitingLine = STILL_WAITING,
            timeoutMs = 120_000,
            schedule = timer::schedule,
        ),
    )

    @Test
    fun `speech without the wake phrase is never sent and the mic reopens`() {
        controller.start()

        speech.emitFinal("what is the build doing")

        assertTrue(sent.isEmpty())
        assertEquals(0, cues)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(2, speech.startCount)
    }

    @Test
    fun `wake plus a question sends only the question, with a cue`() {
        controller.start()

        speech.emitFinal("Hey Helm, is the build done?")

        assertEquals(listOf("is the build done?"), sent)
        assertEquals(1, cues)
        assertTrue(controller.state.value.awaiting)
    }

    @Test
    fun `wake alone asks Yes, then the next utterance is the question`() {
        controller.start()

        speech.emitFinal("hey helm")

        assertEquals(listOf(YES), tts.spoken)
        assertTrue(sent.isEmpty())
        tts.finish()
        speech.emitFinal("is the build done")

        assertEquals(listOf("is the build done"), sent)
    }

    @Test
    fun `exactly one reply is spoken, then standby`() {
        controller.start()
        speech.emitFinal("hey helm status")

        controller.onReply("all green")
        controller.onReply("and another thing")
        tts.finish()
        controller.onReply("unprompted chatter")

        assertEquals(listOf("all green"), tts.spoken)
        assertEquals(CallPhase.Listening, controller.state.value.phase)
        assertEquals(false, controller.state.value.awaiting)
    }

    @Test
    fun `nothing is spoken before a question is asked`() {
        controller.start()

        controller.onReply("the session is chatting")

        assertTrue(tts.spoken.isEmpty())
    }

    @Test
    fun `a slow reply gets a holding line and is still spoken later`() {
        controller.start()
        speech.emitFinal("hey helm run the tests")

        timer.fire()
        assertEquals(listOf(STILL_WAITING), tts.spoken)
        tts.finish()
        controller.onReply("tests passed")

        assertEquals(listOf(STILL_WAITING, "tests passed"), tts.spoken)
    }

    @Test
    fun `a reply in time cancels the timeout`() {
        controller.start()
        speech.emitFinal("hey helm status")

        controller.onReply("green")

        assertEquals(1, timer.cancelled)
    }

    @Test
    fun `a failed send is spoken and ends the question`() {
        sendWorks = false
        controller.start()

        speech.emitFinal("hey helm status")

        assertEquals(listOf(SEND_FAILED), tts.spoken)
        assertEquals(false, controller.state.value.awaiting)
        assertEquals(1, timer.cancelled)
    }

    @Test
    fun `turning standby off releases the mic and a late timeout says nothing`() {
        controller.start()
        speech.emitFinal("hey helm status")

        controller.hangUp()
        timer.fire()

        assertEquals(CallPhase.Ended, controller.state.value.phase)
        assertEquals(1, speech.releaseCount)
        assertTrue(tts.spoken.isEmpty())
    }

    @Test
    fun `the window after Yes closes, so a later remark is not sent`() {
        controller.start()
        speech.emitFinal("hey helm")
        tts.finish()

        timer.fire()
        speech.emitFinal("pass me the salt")

        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a failing recogniser backs off, doubling to a cap, and a result resets it`() {
        controller.start()

        repeat(7) {
            speech.emitError(SpeechError.Busy)
            timer.fire()
        }

        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), timer.delays)
        // Restarts only happen when the backed-off timer fires: 1 start + 7 retries.
        assertEquals(8, speech.startCount)

        speech.emitFinal("just talking")
        speech.emitError(SpeechError.Busy)
        assertEquals(1_000L, timer.delays.last())
    }

    @Test
    fun `a second wake while awaiting is ignored, so the first answer is still spoken`() {
        controller.start()
        speech.emitFinal("hey helm first question")

        speech.emitFinal("hey helm second question")
        controller.onReply("first answer")

        assertEquals(listOf("first question"), sent)
        assertEquals(listOf("first answer"), tts.spoken)
    }

    /** A hand-cranked clock. [fire] runs the most recently scheduled action still pending. */
    private class FakeTimer {
        private val pending = mutableListOf<() -> Unit>()
        val delays = mutableListOf<Long>()
        var cancelled = 0
            private set

        fun schedule(delayMs: Long, action: () -> Unit): () -> Unit {
            delays += delayMs
            pending += action
            return { if (pending.remove(action)) cancelled++ }
        }

        fun fire() {
            val action = pending.removeLastOrNull() ?: return
            action()
        }
    }

    private companion object {
        const val SEND_FAILED = "That did not send."
        const val YES = "Yes?"
        const val STILL_WAITING = "Still waiting, I'll tell you."
    }
}
