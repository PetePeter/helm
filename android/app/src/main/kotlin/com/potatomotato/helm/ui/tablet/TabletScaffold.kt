package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.SharedPreferencesTabletPaneHeightStore
import com.potatomotato.helm.data.TabletPaneHeightStore
import com.potatomotato.helm.ui.HomeAppBar
import com.potatomotato.helm.ui.PhoneScaffoldActions
import com.potatomotato.helm.ui.PhoneScaffoldState
import com.potatomotato.helm.ui.SessionTabBody
import com.potatomotato.helm.ui.components.TodoSheet
import com.potatomotato.helm.ui.keyboard.LocalKeyboardFocusState
import com.potatomotato.helm.ui.keyboard.keyboardFocusTarget
import com.potatomotato.helm.ui.sessions.SessionListScreen
import com.potatomotato.helm.ui.sessions.SessionRows
import com.potatomotato.helm.ui.theme.HelmColors

@Composable
internal fun TabletScaffold(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    layout: TabletLayout,
) {
    val appContext = LocalContext.current.applicationContext
    val heightStore = remember(appContext) { SharedPreferencesTabletPaneHeightStore(appContext) }
    var pickerOpen by rememberSaveable { mutableStateOf(false) }
    var fallbackTodosOpen by rememberSaveable { mutableStateOf(false) }
    val keyboardFocus = LocalKeyboardFocusState.current
    val todosOpen = keyboardFocus?.todosSheetOpen ?: fallbackTodosOpen
    val setTodosOpen: (Boolean) -> Unit = { open ->
        if (keyboardFocus != null) keyboardFocus.todosSheetOpen = open else fallbackTodosOpen = open
    }
    val shellState = TabletShellState(pickerOpen, todosOpen)
    val session = state.open
    val atRoot = session == null && state.homeState.destination == com.potatomotato.helm.ui.Destination.Thread
    LaunchedEffect(layout) {
        if (layout == TabletLayout.Expanded) {
            pickerOpen = false
            setTodosOpen(false)
        }
    }
    BackHandler(enabled = atRoot) { state.homeState.backAtRoot(state.homeState.leaving) }
    LaunchedEffect(atRoot) { if (!atRoot) state.homeState.leaving = false }
    BackHandler(enabled = layout == TabletLayout.Collapsed && (session != null || pickerOpen || todosOpen)) {
        val back = shellState.back()
        pickerOpen = back.state.pickerOpen
        setTodosOpen(back.state.todosOpen)
        if (back.clearSessionSelection) state.homeState.clearSessionSelection()
    }

    Box(
        modifier = state.modifier.fillMaxSize().keyboardFocusTarget(
            keyboardFocus?.sessionListRequester.takeIf { layout == TabletLayout.Collapsed },
        ),
    ) {
        TabletShellFrame(
            topBar = {
                if (layout != TabletLayout.Expanded) TabletHomeAppBar(state, actions)
            },
            content = {
                when (layout) {
                    TabletLayout.Phone -> Unit
                    TabletLayout.Collapsed -> if (session == null) {
                        TabletCollapsedEmptyPane(
                            header = {
                                TabletSessionHeader(
                                    session = null,
                                    sessions = state.listedSessions,
                                    unread = state.unreadCounts,
                                    contextHistories = state.contextHistories,
                                    collapsed = true,
                                    shell = shellState,
                                    onTogglePicker = {
                                        pickerOpen = if (pickerOpen) shellState.dismissPicker().pickerOpen else shellState.openPicker().pickerOpen
                                    },
                                    onPickSession = { id ->
                                        val selection = shellState.pickSession(id)
                                        pickerOpen = selection.state.pickerOpen
                                        setTodosOpen(selection.state.todosOpen)
                                        state.homeState.selectSession(selection.sessionId)
                                    },
                                    onOpenTodos = {},
                                )
                            },
                        )
                    } else {
                        CollapsedSession(state, actions, session, shellState) { next ->
                            pickerOpen = next.pickerOpen
                            setTodosOpen(next.todosOpen)
                        }
                    }
                    TabletLayout.Expanded -> ExpandedSession(state, actions, heightStore, shellState)
                }
            },
        )

        if (layout == TabletLayout.Collapsed && todosOpen && session != null) {
            TodoSheet(todos = session.todos, onDismiss = { setTodosOpen(false) })
        }
    }
}

@Composable
private fun CollapsedSession(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    session: HelmSession,
    shell: TabletShellState,
    onShellState: (TabletShellState) -> Unit,
) {
    SessionDetail(
        state = state,
        actions = actions,
        session = session,
        header = { actionBar ->
            TabletSessionHeader(
                session = session,
                sessions = state.listedSessions,
                unread = state.unreadCounts,
                contextHistories = state.contextHistories,
                collapsed = true,
                shell = shell,
                onTogglePicker = {
                    onShellState(if (shell.pickerOpen) shell.dismissPicker() else shell.openPicker())
                },
                onPickSession = { id ->
                    val selection = shell.pickSession(id)
                    onShellState(selection.state)
                    state.homeState.selectSession(selection.sessionId)
                },
                onOpenTodos = { onShellState(shell.openTodos()) },
                actionBar = actionBar,
            )
        },
    )
}

@Composable
private fun ExpandedSession(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    heightStore: TabletPaneHeightStore,
    shell: TabletShellState,
) {
    BoxWithConstraints(modifier = state.modifier.fillMaxSize().background(HelmColors.Bg)) {
        val listWidth = (maxWidth * 0.34f).coerceIn(300.dp, 420.dp)
        TabletExpandedShell(
            listWidth = listWidth,
            heightStore = heightStore,
            sessionsHeader = { TabletHomeAppBar(state, actions, compact = true) },
            sessions = { modifier ->
                SessionListScreen(
                    sessions = state.listedSessions,
                    linkState = state.linkState,
                    reach = state.reach,
                    capabilities = state.capabilities,
                    unread = state.unreadCounts,
                    contextHistories = state.contextHistories,
                    onOpen = { state.homeState.selectSession(it.id) },
                    onLongPress = { state.homeState.openSessionSheet(it.id) },
                    spawnInFlight = state.spawnInFlight,
                    onNewSession = actions.root.onNewSession,
                    onPairDesktop = actions.root.onPairDesktop,
                    selectedId = state.homeState.selectedSessionId,
                    modifier = modifier,
                )
            },
            todos = { modifier ->
                TodoPane(state.open?.todos.orEmpty(), modifier)
            },
            detail = { modifier ->
                val session = state.open
                if (session == null) {
                    Box(modifier, contentAlignment = Alignment.Center) {
                        Text(text = TABLET_SELECT_SESSION, color = HelmColors.Faint)
                    }
                } else {
                    SessionDetail(
                        state = state,
                        actions = actions,
                        session = session,
                        modifier = modifier,
                        header = { actionBar ->
                            TabletSessionHeader(
                                session = session,
                                sessions = state.listedSessions,
                                unread = state.unreadCounts,
                                contextHistories = state.contextHistories,
                                collapsed = false,
                                shell = shell,
                                onTogglePicker = {},
                                onPickSession = {},
                                onOpenTodos = {},
                                actionBar = actionBar,
                            )
                        },
                    )
                }
            }
        )
    }
}

@Composable
private fun TabletHomeAppBar(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    compact: Boolean = false,
) {
    HomeAppBar(
        linkState = state.linkState,
        homeTab = state.homeState.homeTab,
        notificationsEnabled = state.notificationsEnabled,
        onSelectHomeTab = { tab ->
            if (tab != state.homeState.homeTab) {
                state.homeState.clearSessionSelection()
                actions.root.onSelectHomeTab(tab)
            }
        },
        onLinkClick = actions.root.onLinkClick,
        onToggleNotifications = actions.root.onToggleNotifications,
        onExportLogs = actions.root.onExportLogs,
        compact = compact,
    )
}

@Composable
private fun SessionDetail(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    session: HelmSession,
    modifier: Modifier = Modifier.fillMaxSize(),
    header: @Composable (@Composable () -> Unit) -> Unit,
) {
    val neighbors = SessionRows.unreadNeighbors(state.listedSessionIds, session.id, state.unreadCounts)
    TabletSessionDetail(
        modifier = modifier,
        session = session,
        context = state.contextHistories[session.id],
        linkState = state.linkState,
        tab = state.homeState.sessionTab,
        capabilities = state.capabilities,
        clis = state.clis,
        actions = TabletSessionDetailActions(
            onSelectTab = actions.session.onSelectTab,
            onBack = actions.session.onBackToList,
            onOverflow = actions.session.onOverflow,
            onSessionAction = actions.overlay.onSessionAction,
            onRename = actions.overlay.onRenameSession,
            onSwitchCli = actions.overlay.onSwitchCli,
        ),
        header = header,
    ) {
        state.saveableStateHolder.SaveableStateProvider("session-tab:${session.id}") {
            SessionTabBody(
                state = state,
                actions = actions,
                session = session,
                onSwipeSession = null,
                earlierUnread = neighbors.earlierSessions,
                laterUnread = neighbors.laterSessions,
            )
        }
    }
}

