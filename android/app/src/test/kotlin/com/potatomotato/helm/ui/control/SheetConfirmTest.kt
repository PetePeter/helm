package com.potatomotato.helm.ui.control

import com.potatomotato.helm.data.SessionAction
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
    fun `everything else fires at once`() {
        for (action in SessionAction.entries - SessionAction.Close - SessionAction.Compact - SessionAction.Clear) {
            assertFalse(requiresConfirmation(action))
        }
    }
}
