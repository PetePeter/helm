package com.potatomotato.helm.ui.control

import com.potatomotato.helm.R
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.theme.HelmColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which sheet actions stop for a confirmation before they spend a wire call.
 * Pure on purpose — the rule is the whole design of the sheet's confirm budget:
 * only what is hard to undo asks, so the prompt still means something.
 */
class SheetConfirmTest {

    @Test
    fun `close confirms — it stops the CLI and is not undoable`() {
        assertTrue(requiresConfirmation(SessionAction.Close))
    }

    @Test
    fun `compact confirms — it rewrites the context the session carries`() {
        assertTrue(requiresConfirmation(SessionAction.Compact))
    }

    @Test
    fun `clear confirms — it wipes the conversation the session carries`() {
        assertTrue(requiresConfirmation(SessionAction.Clear))
    }

    @Test
    fun `helm compact confirms — it clears the live context before reloading it`() {
        assertTrue(requiresConfirmation(SessionAction.HelmCompact))
    }

    @Test
    fun `everything else fires at once`() {
        val confirming = setOf(SessionAction.Close, SessionAction.Compact, SessionAction.Clear, SessionAction.HelmCompact)
        for (action in SessionAction.entries - confirming) {
            assertFalse(requiresConfirmation(action))
        }
    }

    @Test
    fun `shared confirmation copy retains the action-specific warning and tone`() {
        assertEquals(R.string.control_confirm_close, SessionAction.Close.confirmation?.messageRes)
        assertEquals(HelmColors.Danger, SessionAction.Close.confirmation?.confirmColor)
        assertEquals(R.string.control_confirm_compact, SessionAction.Compact.confirmation?.messageRes)
        assertEquals(HelmColors.Accent, SessionAction.Compact.confirmation?.confirmColor)
        assertEquals(R.string.control_confirm_clear, SessionAction.Clear.confirmation?.messageRes)
        assertEquals(HelmColors.Danger, SessionAction.Clear.confirmation?.confirmColor)
        assertEquals(null, SessionAction.Stop.confirmation)
    }
}
