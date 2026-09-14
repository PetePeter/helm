package com.potatomotato.helm.ui.control

import com.potatomotato.helm.ui.control.RenameRules.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the rename dialog will and will not send. Pure on purpose — these are
 * the rules that keep the confirm honest (a no-op never spends a wire call, a
 * name the desktop would clamp is never asked for), and they are logic, not
 * layout.
 */
class RenameRulesTest {

    @Test
    fun `a changed name of any length up to the clamp is sendable`() {
        assertEquals(Verdict.Ok, RenameRules.judge("work", "kitchen"))
        assertEquals(Verdict.Ok, RenameRules.judge("work", "x".repeat(RenameRules.MAX_LENGTH)))
    }

    @Test
    fun `blank and whitespace-only input keeps the confirm dark`() {
        assertEquals(Verdict.Blank, RenameRules.judge("work", ""))
        assertEquals(Verdict.Blank, RenameRules.judge("work", "   "))
        assertFalse(RenameRules.renamable("work", "\t\n "))
    }

    @Test
    fun `the unchanged name is a no-op and never sendable`() {
        assertEquals(Verdict.Unchanged, RenameRules.judge("work", "work"))
        assertFalse(RenameRules.renamable("work", "work"))
    }

    @Test
    fun `one past the clamp is refused and the clamp itself is not`() {
        assertEquals(Verdict.TooLong, RenameRules.judge("work", "x".repeat(RenameRules.MAX_LENGTH + 1)))
        assertEquals(
            Verdict.Ok,
            RenameRules.judge("work", "x".repeat(RenameRules.MAX_LENGTH)),
        )
    }

    @Test
    fun `surrounding whitespace does not make a changed name a no-op or a send carry it`() {
        // " work " is judged by what it trims to: a real change, sendable.
        assertEquals(Verdict.Ok, RenameRules.judge("work", "  kitchen  "))
        // And a padded current name is still just the current name.
        assertEquals(Verdict.Unchanged, RenameRules.judge("work", "  work  "))
    }

    /** The single question the dialog's confirm button asks. */
    @Test
    fun `renamable is exactly the Ok verdict`() {
        assertTrue(RenameRules.renamable("work", "kitchen"))
        assertFalse(RenameRules.renamable("work", "work"))
        assertFalse(RenameRules.renamable("work", ""))
    }
}
