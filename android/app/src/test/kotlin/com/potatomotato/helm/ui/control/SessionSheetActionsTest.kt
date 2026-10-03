package com.potatomotato.helm.ui.control

import com.potatomotato.helm.data.SessionAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionSheetActionsTest {
    @Test
    fun `sheet offers the inverse keep-warm action for the current state`() {
        val offActions = sessionSheetActionGroups(keepWarm = false, frozen = false).flatMap { it.actions }
        assertTrue(SessionAction.KeepWarmOn in offActions)
        assertFalse(SessionAction.KeepWarmOff in offActions)

        val onActions = sessionSheetActionGroups(keepWarm = true, frozen = false).flatMap { it.actions }
        assertTrue(SessionAction.KeepWarmOff in onActions)
        assertFalse(SessionAction.KeepWarmOn in onActions)
    }

    @Test
    fun `sheet groups actions by topic in a fixed order, mildest first`() {
        val groups = sessionSheetActionGroups(keepWarm = false, frozen = false)
        assertEquals(
            listOf(
                SessionActionCategory.CHAT to listOf(SessionAction.Call, SessionAction.Stop, SessionAction.Snapshot),
                SessionActionCategory.CONTEXT to
                    listOf(SessionAction.HelmCompact, SessionAction.Compact, SessionAction.Clear),
                SessionActionCategory.SESSION to listOf(
                    SessionAction.Rename,
                    SessionAction.SwitchCli,
                    SessionAction.KeepWarmOn,
                    SessionAction.Freeze,
                    SessionAction.Clone,
                    SessionAction.Spawn,
                    SessionAction.Close,
                ),
            ),
            groups.map { it.category to it.actions },
        )
    }

    @Test
    fun `sheet offers the inverse freeze action for the current state`() {
        val activeActions = sessionSheetActionGroups(keepWarm = false, frozen = false).flatMap { it.actions }
        assertTrue(SessionAction.Freeze in activeActions)
        assertFalse(SessionAction.Unfreeze in activeActions)

        val frozenActions = sessionSheetActionGroups(keepWarm = false, frozen = true).flatMap { it.actions }
        assertTrue(SessionAction.Unfreeze in frozenActions)
        assertFalse(SessionAction.Freeze in frozenActions)
    }
}
