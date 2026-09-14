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
        assertEquals(ActionNotice(SessionAction.Close, ActionOutcome.Refused), control.notice.value)

        control.noticed(SessionAction.Compact, ActionOutcome.Failed("No link to Helm"))
        assertEquals(
            ActionNotice(SessionAction.Compact, ActionOutcome.Failed("No link to Helm")),
            control.notice.value,
        )
    }

    @Test
    fun `a dismissed notice stays dismissed`() {
        control.noticed(SessionAction.Spawn, ActionOutcome.Done)

        control.clearNotice()

        assertNull(control.notice.value)
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

        assertEquals(
            listOf(
                HelmDirectory("x:\\coding\\gamepad-cli-hub", "Helm"),
                HelmDirectory("/home/o/work/api", "api"),
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
    fun `a directory failure is readable state that a new ask clears`() {
        control.directoriesFailed("Tool not permitted")
        assertEquals("Tool not permitted", control.directoriesError.value)

        control.directoriesRequested()
        assertNull(control.directoriesError.value)
    }

    private fun tail(vararg lines: String): JSONObject =
        JSONObject("""{"stripped":[${lines.joinToString(",") { "\"$it\"" }}],"returnedLines":${lines.size}}""")
}
