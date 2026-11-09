package com.potatomotato.helm.ui.keyboard

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.onPreviewKeyEvent
import com.potatomotato.helm.ui.PhoneScaffoldActions
import com.potatomotato.helm.ui.PhoneScaffoldState
import com.potatomotato.helm.ui.control.SessionActionDialogState
import com.potatomotato.helm.ui.control.SessionActionDialogs
import com.potatomotato.helm.ui.components.TodoSheet
import com.potatomotato.helm.ui.tablet.TabletLayout
import com.potatomotato.helm.voice.PttKeyBindingStore

@Composable
internal fun KeyboardWorkspaceHost(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    layout: TabletLayout,
    focus: KeyboardFocusState,
    bindingStore: PttKeyBindingStore,
    actionDialogs: SessionActionDialogState,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalKeyboardFocusState provides focus) {
        LaunchedEffect(focus.pendingFocusTarget, layout, state.homeState.homeTab, state.homeState.destination) {
            val target = focus.pendingFocusTarget ?: return@LaunchedEffect
            withFrameNanos { }
            when (target) {
                KeyboardFocusTarget.Sessions -> focus.sessionListRequester.requestFocus()
                KeyboardFocusTarget.Todos -> focus.todoPaneRequester.requestFocus()
            }
            focus.clearFocusRequest(target)
        }

        Box(
            modifier = Modifier.fillMaxSize().keyboardPttEvents(bindingStore).onPreviewKeyEvent { event ->
                val command = KeyMap.workspaceCommand(
                    stroke = event.toKeyStroke(),
                    workspaceBlocked = workspaceShortcutsBlocked(
                        activeInWindowModalCount = focus.activeInWindowModalCount,
                        todosSheetOpen = focus.todosSheetOpen,
                        destination = state.homeState.destination,
                        actionDialogOpen = actionDialogs.isOpen,
                    ),
                    sessionViewFocused = state.open != null &&
                        state.homeState.destination == com.potatomotato.helm.ui.Destination.Thread,
                    composerFocused = false,
                ) ?: return@onPreviewKeyEvent false
                dispatchKeyCommand(
                    command,
                    KeyCommandContext(
                        state = state,
                        actions = actions,
                        actionDialogs = actionDialogs,
                        focus = focus,
                        layout = layout,
                    ),
                )
                true
            },
        ) {
            content()
            state.open?.let { session ->
                SessionActionDialogs(
                    state = actionDialogs,
                    sessionName = session.name,
                    clis = state.clis,
                    onAction = actions.overlay.onSessionAction,
                    onRename = actions.overlay.onRenameSession,
                    onSwitchCli = actions.overlay.onSwitchCli,
                    showConfirmationDialog = true,
                )
                if (layout == TabletLayout.Phone && focus.todosSheetOpen) {
                    TodoSheet(
                        todos = session.todos,
                        onDismiss = { focus.todosSheetOpen = false },
                    )
                }
            }
        }
    }
}
