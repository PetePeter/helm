package com.potatomotato.helm.ui.keyboard

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import com.potatomotato.helm.ui.Destination
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable

internal enum class KeyboardFocusTarget { Sessions, Todos }

@Stable
internal class KeyboardFocusState {
    val sessionListRequester = FocusRequester()
    val todoPaneRequester = FocusRequester()

    var todosSheetOpen by mutableStateOf(false)
    var activeInWindowModalCount by mutableStateOf(0)
        private set
    var pendingFocusTarget by mutableStateOf<KeyboardFocusTarget?>(null)

    fun registerInWindowModal() {
        activeInWindowModalCount++
    }

    fun unregisterInWindowModal() {
        activeInWindowModalCount = (activeInWindowModalCount - 1).coerceAtLeast(0)
    }

    fun focusSessions() {
        pendingFocusTarget = KeyboardFocusTarget.Sessions
    }

    fun focusTodos(expandedPane: Boolean) {
        todosSheetOpen = !expandedPane
        pendingFocusTarget = KeyboardFocusTarget.Todos
    }

    fun clearFocusRequest(target: KeyboardFocusTarget) {
        if (pendingFocusTarget == target) pendingFocusTarget = null
    }
}

internal fun workspaceShortcutsBlocked(
    activeInWindowModalCount: Int,
    todosSheetOpen: Boolean,
    destination: Destination,
    actionDialogOpen: Boolean,
): Boolean = activeInWindowModalCount > 0 ||
    todosSheetOpen || destination != Destination.Thread || actionDialogOpen

internal val LocalKeyboardFocusState = staticCompositionLocalOf<KeyboardFocusState?> { null }

internal fun Modifier.keyboardFocusTarget(requester: FocusRequester?): Modifier =
    if (requester == null) this else focusRequester(requester).focusable()
