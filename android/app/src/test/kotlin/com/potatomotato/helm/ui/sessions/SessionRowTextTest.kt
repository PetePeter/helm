package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.data.SessionEta
import com.potatomotato.helm.data.SessionEtaRange
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

    @Test
    fun `eta labels round up future and overdue minutes at the deadline boundary`() {
        assertEquals(SessionRowText.EtaLabel(12L, overdue = false), SessionRowText.etaLabel(
            SessionEta(NOW + 12 * 60_000), NOW,
        ))
        assertEquals(SessionRowText.EtaLabel(1L, overdue = false), SessionRowText.etaLabel(
            SessionEta(NOW + 1), NOW,
        ))
        assertEquals(SessionRowText.EtaLabel(0L, overdue = false), SessionRowText.etaLabel(
            SessionEta(NOW), NOW,
        ))
        assertEquals(SessionRowText.EtaLabel(1L, overdue = true), SessionRowText.etaLabel(
            SessionEta(NOW - 1), NOW,
        ))
        assertEquals(SessionRowText.EtaLabel(8L, overdue = true), SessionRowText.etaLabel(
            SessionEta(NOW - 8 * 60_000), NOW,
        ))
        assertNull(SessionRowText.etaLabel(null, NOW))
    }

    @Test
    fun `header eta converts the learned range to remaining minutes`() {
        val eta = SessionEta(
            atEpochMs = NOW + 12 * 60_000,
            range = SessionEtaRange(NOW + 9 * 60_000 + 1, NOW + 16 * 60_000, 5),
        )
        assertEquals(
            SessionRowText.EtaHeaderLabel(12L, false, 10L, 16L),
            SessionRowText.etaHeaderLabel(eta, NOW),
        )
        assertEquals(
            SessionRowText.EtaHeaderLabel(12L, false, null, null),
            SessionRowText.etaHeaderLabel(SessionEta(NOW + 12 * 60_000), NOW),
        )
    }

    @Test
    fun `next eta transition follows a non-minute-aligned deadline`() {
        val eta = SessionEta(NOW + 90_000)

        assertEquals(
            NOW + 90_000,
            SessionRowText.nextEtaTransitionAt(listOf(eta), nowMs = NOW + 60_000),
        )
    }

    @Test
    fun `the zero-minute eta transitions to overdue just after its deadline`() {
        val eta = SessionEta(NOW)

        assertEquals(SessionRowText.EtaLabel(0L, false), SessionRowText.etaLabel(eta, NOW))
        assertEquals(NOW + 1, SessionRowText.nextEtaTransitionAt(listOf(eta), nowMs = NOW))
        assertEquals(SessionRowText.EtaLabel(1L, true), SessionRowText.etaLabel(eta, NOW + 1))
    }

    @Test
    fun `the earliest active range boundary wins over a later eta`() {
        val eta = SessionEta(
            atEpochMs = NOW + 5 * 60_000,
            range = SessionEtaRange(NOW + 30_000, NOW + 2 * 60_000, 5),
        )

        assertEquals(NOW + 30_000, SessionRowText.nextEtaTransitionAt(listOf(eta), NOW))
    }

    @Test
    fun `an expired learned range is omitted from the header`() {
        val eta = SessionEta(
            atEpochMs = NOW - 8 * 60_000,
            range = SessionEtaRange(NOW - 16 * 60_000, NOW, 5),
        )

        assertEquals(
            SessionRowText.EtaHeaderLabel(8L, true, null, null),
            SessionRowText.etaHeaderLabel(eta, NOW),
        )
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
