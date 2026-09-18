package com.potatomotato.helm.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The snapshot tail and the action notices — the state screens 4 and 7 render.
 *
 * The interesting cases are all malformed or absent answers, because the phone
 * cannot see what the desktop meant to send: a tail that never arrived must not
 * render as a session that printed nothing.
 */
class ControlRepositoryTest {
    private val control = ControlRepository()

    @Test
    fun `a stripped tail becomes the lines on screen, in order`() {
        control.snapshotRequested(200)
        assertEquals(Snapshot.Loading(200), control.snapshot.value)

        control.snapshotArrived(tail("$ npm test", "5312 passed", ""), requested = 200)

        assertEquals(
            Snapshot.Lines(listOf("$ npm test", "5312 passed", ""), 200),
            control.snapshot.value,
        )
    }

    @Test
    fun `an answer with no stripped tail fails rather than showing an empty terminal`() {
        control.snapshotRequested(50)

        // The phone asked for the cleaned tail. A result without one means Helm
        // answered something else; an empty list would read as "nothing has run".
        control.snapshotArrived(JSONObject("""{"returnedLines":0,"raw":["x"]}"""), requested = 50)

        assertTrue(control.snapshot.value is Snapshot.Failed)
    }

    @Test
    fun `the requested line count starts at the smallest chip`() {
        assertEquals(50, control.requestedLines.value)
    }

    @Test
    fun `a request persists its line count for the chip row and the refresh`() {
        control.snapshotRequested(50)

        assertEquals(50, control.requestedLines.value)
    }

    @Test
    fun `a failed answer preserves the last requested line count`() {
        control.snapshotRequested(500)
        control.snapshotFailed("Helm did not answer before the request timed out")

        // The chip row and refresh read this count, and the screen the user is
        // looking at is the failure — the ask they made must stay on it.
        assertEquals(500, control.requestedLines.value)
    }

    @Test
    fun `an arrival preserves the last requested line count`() {
        control.snapshotRequested(50)
        control.snapshotArrived(tail("$ npm test"), requested = 50)

        assertEquals(50, control.requestedLines.value)
    }

    @Test
    fun `a later request replaces the persisted line count`() {
        control.snapshotRequested(50)
        control.snapshotRequested(500)

        assertEquals(500, control.requestedLines.value)
    }

    @Test
    fun `a refusal and a dead link are different notices, because they mean opposite things`() {
        control.noticed(SessionAction.Close, ActionOutcome.Refused)
        assertEquals(
            ActionNotice(seq = 1, action = SessionAction.Close, outcome = ActionOutcome.Refused),
            control.notice.value,
        )

        control.noticed(SessionAction.Compact, ActionOutcome.Failed("No link to Helm"))
        assertEquals(
            ActionNotice(seq = 2, action = SessionAction.Compact, outcome = ActionOutcome.Failed("No link to Helm")),
            control.notice.value,
        )
    }

    @Test
    fun `two identical outcomes are two notices, because the second must still be said`() {
        control.noticed(SessionAction.Spawn, ActionOutcome.Refused)
        val first = control.notice.value

        control.noticed(SessionAction.Spawn, ActionOutcome.Refused)
        val second = control.notice.value

        // Byte-identical to the first, yet NOT the first: the bar keys its
        // dismiss timer on the notice, and an equal second would dedup against
        // the first and never be shown.
        assertTrue(first != second)
        assertEquals(first!!.action, second!!.action)
        assertEquals(first.outcome, second.outcome)
        assertTrue(second.seq > first.seq)
    }

    @Test
    fun `a dismissed notice stays dismissed`() {
        control.noticed(SessionAction.Spawn, ActionOutcome.Done)

        control.clearNotice()

        assertNull(control.notice.value)
    }

    @Test
    fun `a spawn raises the in-flight flag and nothing else does`() {
        assertFalse(control.spawnInFlight.value)

        control.spawnStarted()

        assertTrue(control.spawnInFlight.value)
    }

    @Test
    fun `a settled spawn clears the in-flight flag`() {
        control.spawnStarted()

        control.spawnSettled()

        assertFalse(control.spawnInFlight.value)
    }

    @Test
    fun `directories arrive with the desktop's own label and the path as identity`() {
        assertTrue(
            control.directoriesArrived(
                JSONArray(
                    """[{"dirPath":"x:\\coding\\gamepad-cli-hub","name":"Helm"},
                       {"dirPath":"/home/o/work/api"},
                       {"name":"pathless"}]""",
                ),
            ),
        )

        // Sorted by project label (or the folder's own name when there is
        // none), which is what the row shows.
        assertEquals(
            listOf(
                HelmDirectory("/home/o/work/api", "api"),
                HelmDirectory("x:\\coding\\gamepad-cli-hub", "Helm"),
            ),
            control.directories.value,
        )
    }

    @Test
    fun `a directory payload that is not a list is refused and changes nothing`() {
        control.directoriesArrived(JSONArray("""[{"dirPath":"/work"}]"""))

        assertFalse(control.directoriesArrived(JSONObject("""{"dirPath":"/work"}""")))

        assertEquals(listOf(HelmDirectory("/work", "work")), control.directories.value)
    }

    @Test
    fun `the CLI catalogue arrives with display names and spawn targets`() {
        assertTrue(
            control.clisArrived(
                JSONArray(
                    """[{"cliType":"claudecode","name":"Claude Code","supportedDirPaths":["x:\\c","/w"]},
                       {"name":"pathless"},
                       {"cliType":"codex"}]""",
                ),
            ),
        )

        // An entry without a cliType is not a CLI; a missing label falls back to
        // the id the wire actually needs.
        assertEquals(
            listOf(
                HelmCli("claudecode", "Claude Code", listOf("x:\\c", "/w")),
                HelmCli("codex", "codex", emptyList()),
            ),
            control.clis.value,
        )
    }

    @Test
    fun `a catalogue that is not a list changes nothing`() {
        assertFalse(control.clisArrived(JSONObject("""{"cliType":"x"}""")))

        assertTrue(control.clis.value.isEmpty())
    }

    @Test
    fun `the CLI catalogue arrives sorted by display name, case-insensitive`() {
        // tool_list answers in the desktop's config order; the phone is the one
        // surface where the list is long enough to read, so it sorts.
        assertTrue(
            control.clisArrived(
                JSONArray(
                    """[{"cliType":"zed","name":"Zed"},
                       {"cliType":"claudecode","name":"claude"},
                       {"cliType":"copilotcli","name":"Copilot"}]""",
                ),
            ),
        )

        assertEquals(
            listOf("claudecode", "copilotcli", "zed"),
            control.clis.value.map { it.cliType },
        )
    }

    @Test
    fun `directories arrive sorted by project label then path`() {
        assertTrue(
            control.directoriesArrived(
                JSONArray(
                    """[{"dirPath":"/w/zeta/alt","name":"alt","projectName":"Zeta"},
                       {"dirPath":"/w/api","name":"api","projectName":"Alpha"},
                       {"dirPath":"/w/zed","name":"zed"},
                       {"dirPath":"/w/zeta","name":"zeta","projectName":"Alpha"},
                       {"dirPath":"/w/alpha2","name":"alpha2","projectName":"alpha"}]""",
                ),
            ),
        )

        // Project label sorts case-insensitively and the folder breaks ties; a
        // folder with no project sorts under its own name.
        assertEquals(
            listOf("/w/alpha2", "/w/api", "/w/zeta", "/w/zed", "/w/zeta/alt"),
            control.directories.value.map { it.path },
        )
    }

    @Test
    fun `a directory failure is readable state that a new ask clears`() {
        control.directoriesFailed("Tool not permitted")
        assertEquals("Tool not permitted", control.directoriesError.value)

        control.directoriesRequested()
        assertNull(control.directoriesError.value)
    }

    @Test
    fun `an artifact landing is parked once and consumed once`() {
        control.artifactLanded(SessionAction.CreateArtifact, "a1")
        assertEquals(ArtifactLanding(SessionAction.CreateArtifact, "a1"), control.artifactLanding.value)

        // Consumed exactly once: a second read sees nothing, so a rotation
        // cannot drag the user back to the artifact they just left.
        assertEquals("a1", control.consumeArtifactLanding()?.artifactId)
        assertNull(control.artifactLanding.value)
        assertNull(control.consumeArtifactLanding())
    }

    @Test
    fun `two identical landings in a row are both honoured`() {
        control.artifactLanded(SessionAction.DeleteArtifact, "a1")
        control.consumeArtifactLanding()

        // The delete navigation is driven by the landing, not the notice: two
        // successful deletes carry byte-identical notices, which a watched
        // state would dedup and strand the user on the editor.
        control.artifactLanded(SessionAction.DeleteArtifact, "a2")

        assertEquals("a2", control.consumeArtifactLanding()?.artifactId)
    }

    @Test
    fun `a create answer that names no artifact still parks a landing`() {
        control.artifactLanded(SessionAction.CreateArtifact, null)

        // The landing carries the null: the editor closes for the list, where
        // the new row is one pull away.
        assertNull(control.consumeArtifactLanding()?.artifactId)
    }

    private fun tail(vararg lines: String): JSONObject =
        JSONObject("""{"stripped":[${lines.joinToString(",") { "\"$it\"" }}],"returnedLines":${lines.size}}""")
}
