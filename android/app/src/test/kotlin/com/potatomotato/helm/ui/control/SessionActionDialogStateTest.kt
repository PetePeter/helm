package com.potatomotato.helm.ui.control

import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionActionDialogStateTest {
    private val actions = sessionActions(
        keepWarm = false,
        frozen = false,
        capabilities = Capabilities.Known(SessionAction.entries.map { it.tool }.toSet()),
    )

    @Test
    fun `Close waits for confirmation and confirm returns the selected action`() {
        val state = SessionActionDialogState()
        val close = actions.entry(SessionAction.Close)

        assertNull(state.select(close))
        assertEquals(close, state.confirmation)
        assertEquals(SessionAction.Close, state.confirm())
        assertNull(state.confirmation)
    }

    @Test
    fun `Rename opens its existing dialog and forbidden actions do nothing`() {
        val state = SessionActionDialogState()
        assertNull(state.select(actions.entry(SessionAction.Rename)))
        assertTrue(state.renaming)
        state.finishRename()
        assertFalse(state.renaming)

        assertNull(state.select(actions.entry(SessionAction.Close).copy(permitted = false)))
        assertNull(state.confirmation)
    }
}
