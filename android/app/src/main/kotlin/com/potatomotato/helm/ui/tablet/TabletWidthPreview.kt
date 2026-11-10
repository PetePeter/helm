package com.potatomotato.helm.ui.tablet

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionTodo
import com.potatomotato.helm.data.TabletPaneHeightStore
import com.potatomotato.helm.ui.HomeAppBar
import com.potatomotato.helm.ui.SessionTabScaffold
import com.potatomotato.helm.ui.chat.ChatScreen
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.sessions.SessionRowsContent
import com.potatomotato.helm.ui.theme.HelmTheme

private val previewSession = HelmSession(
    id = "preview-worker",
    name = "worker-P-1207",
    projectPath = "X:/coding/gamepad-cli-hub",
    cliType = "codex",
    cliTypeName = "Codex",
    activity = SessionState.Active,
    mission = "Adaptive tablet session shell",
    todos = listOf(
        SessionTodo("preview-todo-1", "Keep session panes aligned", waiting = false),
        SessionTodo("preview-todo-2", "Run the tablet release build", waiting = true),
        SessionTodo("preview-todo-3", "Check the collapsed picker", waiting = false),
    ),
)

private val previewSessions = listOf(
    previewSession,
    previewSession.copy(id = "preview-review", name = "review-P-1207", activity = SessionState.Waiting),
)

@Preview(name = "Phone 599dp", widthDp = 599, heightDp = 900)
@Composable
private fun PhoneWidthPreview() {
    HelmTheme {
        SessionTabScaffold(
            modifier = Modifier.fillMaxSize(),
            sessionName = previewSession.name,
            mission = previewSession.mission,
            details = "Working · Codex · git: feat/tablet",
            context = null,
            activity = previewSession.activity,
            linkState = LinkState.Linked,
            tab = SessionTab.Chat,
            onSelectTab = {},
            onBack = {},
            onOverflow = {},
        ) {
            PreviewChatBody(previewSession)
        }
    }
}

@Preview(name = "Tablet collapsed 600dp", widthDp = 600, heightDp = 900)
@Composable
private fun CollapsedWidthPreview() {
    HelmTheme {
        TabletShellFrame(
            modifier = Modifier.fillMaxSize(),
            topBar = { PreviewHomeAppBar() },
            content = {
                TabletCollapsedEmptyPane(
                    header = {
                        TabletSessionHeader(
                            session = null,
                            sessions = previewSessions,
                            unread = emptyMap(),
                            contextHistories = emptyMap(),
                            collapsed = true,
                            shell = TabletShellState(),
                            onTogglePicker = {},
                            onPickSession = {},
                            onOpenTodos = {},
                        )
                    },
                )
            },
        )
    }
}

@Preview(name = "Tablet expanded 840dp", widthDp = 840, heightDp = 900)
@Composable
private fun ExpandedWidthPreview() {
    HelmTheme {
        TabletShellFrame(
            modifier = Modifier.fillMaxSize(),
            topBar = { PreviewHomeAppBar() },
            content = {
                TabletExpandedShell(
                    listWidth = 300.dp,
                    heightStore = PreviewPaneHeightStore,
                    modifier = Modifier.fillMaxSize(),
                    sessions = { modifier ->
                        SessionRowsContent(
                            sessions = previewSessions,
                            unread = emptyMap(),
                            contextHistories = emptyMap(),
                            collapsedGroups = emptySet(),
                            selectedId = previewSession.id,
                            onToggleGroup = {},
                            onOpen = {},
                            onLongPress = {},
                            modifier = modifier,
                        )
                    },
                    todos = { modifier -> TodoPane(previewSession.todos, modifier) },
                    detail = { modifier ->
                        TabletSessionDetail(
                            session = previewSession,
                            context = null,
                            linkState = LinkState.Linked,
                            tab = SessionTab.Chat,
                            capabilities = Capabilities.Known(
                                SessionAction.entries.map { it.tool }.toSet(),
                            ),
                            clis = emptyList(),
                            actions = TabletSessionDetailActions(
                                onSelectTab = {},
                                onBack = {},
                                onOverflow = {},
                                onSessionAction = {},
                                onRename = {},
                                onSwitchCli = {},
                            ),
                            modifier = modifier,
                            header = { actionBar ->
                                TabletSessionHeader(
                                    session = previewSession,
                                    sessions = previewSessions,
                                    unread = emptyMap(),
                                    contextHistories = emptyMap(),
                                    collapsed = false,
                                    shell = TabletShellState(),
                                    onTogglePicker = {},
                                    onPickSession = {},
                                    onOpenTodos = {},
                                    actionBar = actionBar,
                                )
                            },
                            body = { PreviewChatBody(previewSession) },
                        )
                    },
                )
            },
        )
    }
}

@Composable
private fun PreviewHomeAppBar() {
    HomeAppBar(
        linkState = LinkState.Linked,
        homeTab = HomeTab.Sessions,
        notificationsEnabled = true,
        onSelectHomeTab = {},
        onLinkClick = {},
        onToggleNotifications = {},
        onExportLogs = {},
    )
}

@Composable
private fun PreviewChatBody(session: HelmSession) {
    val swipeOffset = remember { Animatable(0f) }
    val messages = remember {
        val now = System.currentTimeMillis()
        listOf(
            ChatMessage("preview-1", "The tablet shell now uses the shared session content.", now - 60_000, fromPhone = false),
            ChatMessage("preview-2", "I can see the header, tabs, and composer at this width.", now, fromPhone = true),
        )
    }
    ChatScreen(
        sessionId = session.id,
        messages = messages,
        onSend = {},
        onRetry = { _, _ -> },
        onDelete = {},
        onTerminal = {},
        swipeOffset = swipeOffset,
        session = session,
    )
}

private object PreviewPaneHeightStore : TabletPaneHeightStore {
    override fun loadTodoHeightDp(): Float = 220f
    override fun saveTodoHeightDp(heightDp: Float) = Unit
}
