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
    fun `sheet groups actions by topic in alphabetical order`() {
        val groups = sessionSheetActionGroups(keepWarm = false, frozen = false)
        assertEquals(
            listOf("CHAT", "CONTEXT", "CREATE", "INSPECT", "REMOVE", "SESSION"),
            groups.map { it.category.name },
        )
        groups.forEach { group ->
            val names = group.actions.map { it.name }
            assertEquals(names.sorted(), names)
        }
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
