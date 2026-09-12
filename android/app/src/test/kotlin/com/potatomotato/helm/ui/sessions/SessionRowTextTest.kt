package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The second line of a session row, and the relative time beside it.
 *
 * Both are decisions made from wire data, and both have real failure modes: a
 * sub-line that says "Idle" on a session demanding a decision, or an age that
 * reads "-1m" because the phone clock sits behind the desktop's.
 */
class SessionRowTextTest {
    private val labels = SessionRowText.Labels(
        needsDecision = "Needs your decision",
        working = "Working",
        waitingApproval = "Waiting on approval",
        idle = "Idle",
        planning = "Planning",
        implementing = "Implementing",
        completed = "Completed",
    )

    // --- sub-line ------------------------------------------------------------

    @Test
    fun `a pending question outranks every other status`() {
        assertEquals(
            "Needs your decision",
            SessionRowText.subLine(
                activity = SessionState.Active,
                questionPending = true,
                aiagentState = "implementing",
                cliTypeName = "claude",
                age = "now",
                labels = labels,
            ),
        )
    }

    @Test
    fun `the aiagent state names the phase and the cli`() {
        assertEquals(
            "Implementing · claude",
            SessionRowText.subLine(
                activity = SessionState.Active,
                questionPending = false,
                aiagentState = "implementing",
                cliTypeName = "claude",
                age = "now",
                labels = labels,
            ),
        )
    }

    @Test
    fun `each aiagent state has its own word`() {
        fun line(state: String) = SessionRowText.subLine(
            activity = SessionState.Active,
            questionPending = false,
            aiagentState = state,
            cliTypeName = "claude",
            age = "now",
            labels = labels,
        )

        assertEquals("Planning · claude", line("planning"))
        assertEquals("Completed · claude", line("completed"))
        assertEquals("Idle · claude", line("idle"))
    }

    @Test
    fun `an unknown aiagent state falls back to the activity word, not to nothing`() {
        // A future Helm can invent a state this build has never heard of; the row
        // still has to say something true.
        assertEquals(
            "Working · claude",
            SessionRowText.subLine(
                activity = SessionState.Active,
                questionPending = false,
                aiagentState = "vibing",
                cliTypeName = "claude",
                age = "now",
                labels = labels,
            ),
        )
    }

    @Test
    fun `waiting says why it is quiet, without a cli suffix`() {
        assertEquals(
            "Waiting on approval",
            SessionRowText.subLine(
                activity = SessionState.Waiting,
                questionPending = false,
                aiagentState = null,
                cliTypeName = "claude",
                age = "3m",
                labels = labels,
            ),
        )
    }

    @Test
    fun `idle carries its age`() {
        fun line(age: String?) = SessionRowText.subLine(
            activity = SessionState.Idle,
            questionPending = false,
            aiagentState = null,
            cliTypeName = "claude",
            age = age,
            labels = labels,
        )

        assertEquals("Idle · 22m", line("22m"))
        assertEquals("Idle", line(null))
        // "Idle · now" is a contradiction — an idle session was not just active.
        assertEquals("Idle", line("now"))
    }

    // --- relative time --------------------------------------------------------

    @Test
    fun `a phone clock sitting behind the desktop reads now, never a negative age`() {
        // Found on-device: 65 s of skew between the tablet and the PC. The wire
        // age is negative for a minute after every refresh without this.
        assertEquals("now", SessionRowText.relativeTime(atEpochMs = NOW + 65_000, nowMs = NOW))
    }

    @Test
    fun `the first age brackets are now, minutes, hours, days`() {
        assertEquals("now", SessionRowText.relativeTime(NOW, NOW))
        assertEquals("now", SessionRowText.relativeTime(NOW - 90_000, NOW))
        assertEquals("3m", SessionRowText.relativeTime(NOW - 3 * 60_000 - 5_000, NOW))
        assertEquals("59m", SessionRowText.relativeTime(NOW - 59 * 60_000, NOW))
        assertEquals("1h", SessionRowText.relativeTime(NOW - 60 * 60_000, NOW))
        assertEquals("2d", SessionRowText.relativeTime(NOW - 48 * 60 * 60_000, NOW))
    }

    @Test
    fun `a session with no last-active stamp shows no age`() {
        assertNull(SessionRowText.relativeTime(atEpochMs = null, nowMs = NOW))
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
