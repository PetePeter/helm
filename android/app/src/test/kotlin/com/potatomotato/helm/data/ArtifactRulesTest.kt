package com.potatomotato.helm.data

import com.potatomotato.helm.data.ArtifactRules.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the artifact editor will and will not send.
 *
 * Pure on purpose, like [com.potatomotato.helm.ui.control.RenameRules]: a blank
 * create that fires, a no-op revision spending a wire call, and a body too big
 * for the link's frame ceiling are logic, not layout. The size rule is the
 * phone-side twin of the desktop's own budget arithmetic (MAX_FRAME_BYTES minus
 * wrapper headroom, in artifact-download.ts): a body the phone authors must fit
 * the SAME 128KiB frame, and one that does not would fail as a torn link rather
 * than a refusal.
 */
class ArtifactRulesTest {

    // ------------------------------------------------------------------ create

    @Test
    fun `a titled note with an empty body is sendable`() {
        // A note with a title and nothing under it is still a note; the desktop
        // accepts an empty version body, so the phone must not second-guess it.
        assertEquals(Verdict.Ok, ArtifactRules.judgeCreate("Note", ""))
    }

    @Test
    fun `a blank title keeps the create dark`() {
        assertEquals(Verdict.Blank, ArtifactRules.judgeCreate("", "body"))
        assertEquals(Verdict.Blank, ArtifactRules.judgeCreate("   ", "body"))
        assertFalse(ArtifactRules.sendableCreate("\t\n", "body"))
    }

    @Test
    fun `a title past the cap is refused and the cap itself is not`() {
        assertEquals(
            Verdict.TooLong,
            ArtifactRules.judgeCreate("x".repeat(ArtifactRules.MAX_TITLE_LENGTH + 1), ""),
        )
        assertEquals(Verdict.Ok, ArtifactRules.judgeCreate("x".repeat(ArtifactRules.MAX_TITLE_LENGTH), ""))
    }

    @Test
    fun `the title the wire carries is the trimmed one`() {
        assertEquals("Note", ArtifactRules.title("  Note  "))
    }

    // ------------------------------------------------------------------ revise

    @Test
    fun `an unchanged body is a no-op and never sendable`() {
        // `session_artifact_update` APPENDS a version; sending the same body
        // again would add a version that says nothing new.
        assertEquals(Verdict.Unchanged, ArtifactRules.judgeRevision("# Report", "# Report"))
        assertFalse(ArtifactRules.sendableRevision("# Report", "# Report"))
    }

    @Test
    fun `a changed body is sendable`() {
        assertEquals(Verdict.Ok, ArtifactRules.judgeRevision("# Report", "# Report, revised"))
    }

    @Test
    fun `whitespace padding around an unchanged body is still a no-op`() {
        assertEquals(Verdict.Unchanged, ArtifactRules.judgeRevision("# Report", "  # Report  "))
    }

    // ------------------------------------------------------------- the frame

    @Test
    fun `a body that cannot fit the link is refused before it is sent`() {
        val over = "x".repeat(ArtifactRules.MAX_EDIT_ESCAPED_BYTES + 1)
        assertEquals(Verdict.TooLarge, ArtifactRules.judgeCreate("Note", over))
        assertEquals(Verdict.TooLarge, ArtifactRules.judgeRevision("", over))
        assertFalse(ArtifactRules.sendableCreate("Note", over))
    }

    @Test
    fun `a body at the budget fits and one byte past it does not`() {
        // The title and body share ONE budget, measured escaped, so the fitting
        // case is a body sized after a real title.
        val title = "Note"
        val body = "x".repeat(ArtifactRules.MAX_EDIT_ESCAPED_BYTES - title.length)
        assertEquals(Verdict.Ok, ArtifactRules.judgeCreate(title, body))
        assertEquals(Verdict.TooLarge, ArtifactRules.judgeCreate(title, body + "x"))
        // A long title shortens what the body may be.
        assertFalse(ArtifactRules.sendableCreate("t".repeat(100), body))
    }

    // ------------------------------------------------------------- escaping

    @Test
    fun `escaping is counted, not assumed`() {
        // A quote doubles.
        assertEquals(2, ArtifactRules.escapedLength("\""))
        // A newline may take the 2-char short form or the 6-char unicode form;
        // the estimate must be safe against the worst of the two.
        assertTrue(ArtifactRules.escapedLength("\n") >= 2)
        assertEquals(1, ArtifactRules.escapedLength("a"))
        // Non-ASCII passes through as UTF-8 bytes, not escapes.
        assertTrue(ArtifactRules.escapedLength("é") >= 2)
        // A surrogate pair is two chars; the count must not UNDER-count it.
        assertTrue(ArtifactRules.escapedLength("\uD83D\uDE00") >= 4)
    }

    @Test
    fun `the estimate is never smaller than the real escaped length`() {
        // The one direction the estimate must not fail in: under-counting lets a
        // body through that the link would tear on.
        val nasty = ("\"\\control\u0001\n\t\u00e9\uD83D\uDE00").repeat(50)
        // A bare value is out of sequence for JSONStringer, so the string rides
        // a one-key object and the fixed wrapper {"c": and } are subtracted.
        val wrapped = org.json.JSONObject().put("c", nasty).toString()
        val reallyEscaped = wrapped.length - 6
        assertTrue(ArtifactRules.escapedLength(nasty) >= reallyEscaped)
    }
}
