package com.potatomotato.helm.ui.tablet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TabletShellStateTest {
    @Test fun selectingSessionReturnsSelectionAndClosesPicker() {
        val result = TabletShellState().openPicker().pickSession("session-7")

        assertEquals("session-7", result.sessionId)
        assertFalse(result.state.pickerOpen)
        assertFalse(result.state.todosOpen)
    }

    @Test fun openingOneCollapsedSurfaceClosesTheOther() {
        val picker = TabletShellState().openTodos().openPicker()
        val todos = picker.openTodos()

        assertTrue(picker.pickerOpen)
        assertFalse(picker.todosOpen)
        assertTrue(todos.todosOpen)
        assertFalse(todos.pickerOpen)
    }

    @Test fun todoTitleShowsOpenCount() {
        assertEquals("✓ 3 open", TabletShellState().todoTitle(3))
        assertEquals("✓ 0 open", TabletShellState().todoTitle(-1))
    }

    @Test fun backDismissesCollapsedSurfaceBeforeClearingSelection() {
        val sheetBack = TabletShellState().openTodos().back()
        val selectionBack = sheetBack.state.back()

        assertFalse(sheetBack.state.todosOpen)
        assertFalse(sheetBack.clearSessionSelection)
        assertTrue(selectionBack.clearSessionSelection)
    }
}
