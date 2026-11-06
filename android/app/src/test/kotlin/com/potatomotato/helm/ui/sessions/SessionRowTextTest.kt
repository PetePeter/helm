package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The second line of a session row, and the relative time beside it.
 *
 * Both are decisions made from wire data, and both have real failure modes: a
 * sub-line that contradicts itself ("Idle · now"), or an age that reads "-1m"
 * because the phone clock sits behind the desktop's.
 */
class SessionRowTextTest {
    private val labels = SessionRowText.Labels(
        working = "Working",
        waitingApproval = "Waiting on approval",
        idle = "Idle",
    )

    // --- sub-line ------------------------------------------------------------

    @Test
    fun `an active session says working and names the cli`() {
        assertEquals(
            "Working · claude",
            SessionRowText.subLine(SessionState.Active, cliTypeName = "claude", age = "now", labels = labels),
        )
    }

    @Test
    fun `waiting says why it is quiet, without a cli suffix`() {
        assertEquals(
            "Waiting on approval",
            SessionRowText.subLine(
                activity = SessionState.Waiting,
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

    @Test
    fun `a mission becomes one ticker line, and a blank one no line at all`() {
        assertEquals("Fix the BLE link. Then ship it.", SessionRowText.missionLine("  Fix the BLE link.\n\n  Then ship it.  "))
        assertEquals(null, SessionRowText.missionLine("   \n "))
        assertEquals(null, SessionRowText.missionLine(null))
    }

    @Test
    fun `line two is status, branch, mission in that order so the mission is what the ellipsis eats`() {
        assertEquals(
            "Working · claude · git: feat/rows · Ship the row layout",
            SessionRowText.detailLine("Working · claude", "git: feat/rows", "Ship the row layout"),
        )
    }

    @Test
    fun `line two drops a missing or blank branch and mission without leaving a separator`() {
        assertEquals("Idle · codex", SessionRowText.detailLine("Idle · codex", null, null))
        assertEquals("Idle · codex", SessionRowText.detailLine("Idle · codex", "  ", "  \n "))
        assertEquals("Idle · codex · Fix backoff", SessionRowText.detailLine("Idle · codex", null, "Fix\nbackoff"))
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
