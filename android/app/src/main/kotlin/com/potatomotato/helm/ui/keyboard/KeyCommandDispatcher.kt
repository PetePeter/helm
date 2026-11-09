package com.potatomotato.helm.ui.keyboard

import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.data.isKeepWarmEnabled
import com.potatomotato.helm.ui.Destination
import com.potatomotato.helm.ui.PhoneScaffoldActions
import com.potatomotato.helm.ui.PhoneScaffoldState
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.control.SessionActionDialogState
import com.potatomotato.helm.ui.control.sessionActions
import com.potatomotato.helm.ui.tablet.TabletLayout

internal data class KeyCommandContext(
    val state: PhoneScaffoldState,
    val actions: PhoneScaffoldActions,
    val actionDialogs: SessionActionDialogState,
    val focus: KeyboardFocusState,
    val layout: TabletLayout,
)

/** Routes mapped keys through the same state owners and permission-aware actions as touch UI. */
internal fun dispatchKeyCommand(command: KeyCommand, context: KeyCommandContext) {
    val state = context.state
    val home = state.homeState
    when (command) {
        is KeyCommand.Ptt -> Unit // PTT is consumed by KeyboardPttEvents before workspace dispatch.
        is KeyCommand.CycleSessions -> cycleSession(state, command.direction)
        is KeyCommand.SelectSession -> state.listedSessionIds.getOrNull(command.index)?.let { selectSession(state, it) }
        is KeyCommand.RunAction -> state.open?.let { session ->
            val catalogue = sessionActions(
                keepWarm = isKeepWarmEnabled(session.keepWarmUntilEpochMs, System.currentTimeMillis()),
                frozen = session.frozen,
                capabilities = state.capabilities,
            )
            catalogue.barActions.getOrNull(command.index)?.let { selectAction(it.action, context) }
        }
        is KeyCommand.SelectSessionTab -> if (state.open != null) {
            showSessionsThread(state)
            home.chooseSessionTab(command.tab)
        }
        KeyCommand.FocusSessions -> {
            showSessionsThread(state)
            home.clearSessionSelection()
            context.focus.focusSessions()
        }
        KeyCommand.FocusTodos -> if (state.open != null) {
            showSessionsThread(state)
            context.focus.focusTodos(expandedPane = context.layout == TabletLayout.Expanded)
        }
        KeyCommand.NewSession -> if (state.capabilities.permits(SessionAction.Spawn)) {
            context.actions.root.onNewSession()
        }
        KeyCommand.RenameSession -> selectAction(SessionAction.Rename, context)
        KeyCommand.CloseSession -> selectAction(SessionAction.Close, context)
        KeyCommand.StopSession -> selectAction(SessionAction.Stop, context)
        KeyCommand.SendComposer, KeyCommand.Consume -> Unit
    }
}

private fun cycleSession(state: PhoneScaffoldState, direction: Int) {
    val ids = state.listedSessionIds
    if (ids.isEmpty()) return
    val current = ids.indexOf(state.homeState.selectedSessionId)
    val next = if (current < 0) {
        if (direction > 0) 0 else ids.lastIndex
    } else {
        (current + direction + ids.size) % ids.size
    }
    selectSession(state, ids[next])
}

private fun selectSession(state: PhoneScaffoldState, sessionId: String) {
    showSessionsThread(state)
    state.homeState.selectSession(sessionId)
}

private fun showSessionsThread(state: PhoneScaffoldState) {
    state.homeState.selectHomeTab(HomeTab.Sessions)
    state.homeState.destination = Destination.Thread
}

private fun selectAction(action: SessionAction, context: KeyCommandContext) {
    val session = context.state.open ?: return
    val catalogue = sessionActions(
        keepWarm = isKeepWarmEnabled(session.keepWarmUntilEpochMs, System.currentTimeMillis()),
        frozen = session.frozen,
        capabilities = context.state.capabilities,
    )
    val entry = catalogue.entries[action] ?: return
    context.actionDialogs.select(entry)?.let(context.actions.overlay.onSessionAction)
}
