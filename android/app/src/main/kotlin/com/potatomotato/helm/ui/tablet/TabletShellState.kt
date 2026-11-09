package com.potatomotato.helm.ui.tablet

/** Saveable UI state and pure transitions for the collapsed tablet session shell. */
internal data class TabletShellState(
    val pickerOpen: Boolean = false,
    val todosOpen: Boolean = false,
) {
    fun openPicker() = copy(pickerOpen = true, todosOpen = false)

    fun openTodos() = copy(pickerOpen = false, todosOpen = true)

    fun dismissPicker() = copy(pickerOpen = false)

    fun dismissTodos() = copy(todosOpen = false)

    fun pickSession(sessionId: String) = TabletSessionSelection(
        state = copy(pickerOpen = false, todosOpen = false),
        sessionId = sessionId,
    )

    fun back() = when {
        todosOpen -> TabletBackTransition(copy(todosOpen = false), clearSessionSelection = false)
        pickerOpen -> TabletBackTransition(copy(pickerOpen = false), clearSessionSelection = false)
        else -> TabletBackTransition(this, clearSessionSelection = true)
    }

    fun todoTitle(openCount: Int): String = "✓ ${openCount.coerceAtLeast(0)} open"

}

/** A pure selection result; HelmHomeState remains the single selected-session owner. */
internal data class TabletSessionSelection(val state: TabletShellState, val sessionId: String)

internal data class TabletBackTransition(val state: TabletShellState, val clearSessionSelection: Boolean)
