package com.potatomotato.helm.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.ui.components.LoadNote
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.LoadViews
import com.potatomotato.helm.ui.components.ProjectPicker
import com.potatomotato.helm.ui.components.SettingsMenuActions
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.components.ContextMenuItem
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.operator.OperatorSummary
import com.potatomotato.helm.ui.operator.OperatorSection
import com.potatomotato.helm.ui.plans.PlanList
import com.potatomotato.helm.ui.components.glyphRes
import com.potatomotato.helm.ui.components.labelRes
import com.potatomotato.helm.ui.contexts.ContextList
import com.potatomotato.helm.ui.time.TimeScreen
import androidx.compose.ui.res.stringResource

/**
 * The chrome a project-scoped root surface wears below the root bar: the
 * project picker, and then the surface itself.
 *
 * ONE OWNER FOR BOTH, for the reason [SessionTabScaffold] is one owner: the
 * Plans and Contexts surfaces must not drift into two different ways of saying
 * which project you are looking at, and switching between them must re-lay-out
 * only the body.
 *
 * A surface with NO project yet renders [noProjectText] instead of its body. Not
 * an empty list — "no plans" and "you have not said which plans" are different
 * sentences, and only one of them is about the plans.
 */
@Composable
internal fun ProjectScoped(
    projects: LoadView<List<HelmProject>>,
    project: HelmProject?,
    onSelectProject: (HelmProject) -> Unit,
    onRetryProjects: () -> Unit,
    noProjectText: String,
    body: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        ProjectPicker(
            projects = projects,
            selected = project,
            onSelect = onSelectProject,
            onRetry = onRetryProjects,
        )
        Box(modifier = Modifier.weight(1f)) {
            if (project == null) LoadNote(noProjectText) else body()
        }
    }
}

@Composable
internal fun PhoneRootContent(state: PhoneScaffoldState, actions: PhoneScaffoldActions) {
    // One bar's context label selects one of the three root surfaces. Every
    // root tab shares the scaffold's exit question: Plans and Contexts stay on
    // their tabs instead of bouncing to Sessions, so there is one exit affordance.
    Column(modifier = Modifier.fillMaxSize()) {
        HomeAppBar(
            linkState = state.linkState,
            homeTab = state.homeState.homeTab,
            notificationsEnabled = state.notificationsEnabled,
            onSelectHomeTab = actions.root.onSelectHomeTab,
            onLinkClick = actions.root.onLinkClick,
            onToggleNotifications = actions.root.onToggleNotifications,
            onExportLogs = actions.root.onExportLogs,
        )
        Box(modifier = Modifier.weight(1f)) {
            when (state.homeState.homeTab) {
                HomeTab.Helm -> Column(modifier = Modifier.fillMaxSize()) {
                    OperatorSection(
                        summary = state.operator,
                        onOpenChat = actions.root.onOpenOperatorChat,
                        onOpenTasks = actions.root.onOpenOperatorTasks,
                        onCall = actions.root.onCallOperator,
                    )
                    if (state.operator is OperatorSummary.On) {
                        Box(modifier = Modifier.weight(1f)) {
                            PhoneChatContent(
                                state = state,
                                actions = actions,
                                sessionId = state.operator.id,
                                onSwipeSession = null,
                                earlierUnread = 0,
                                laterUnread = 0,
                            )
                        }
                    }
                }

                HomeTab.Sessions -> com.potatomotato.helm.ui.sessions.SessionListScreen(
                    sessions = state.listedSessions,
                    linkState = state.linkState,
                    reach = state.reach,
                    capabilities = state.capabilities,
                    unread = state.unreadCounts,
                    contextHistories = state.contextHistories,
                    spawnInFlight = state.spawnInFlight,
                    onOpen = actions.root.onOpenSession,
                    onLongPress = actions.root.onLongPressSession,
                    onNewSession = actions.root.onNewSession,
                    onPairDesktop = actions.root.onPairDesktop,
                )

                HomeTab.Plans -> ProjectScoped(
                    projects = LoadViews.projects(state.projectsState),
                    project = state.project,
                    onSelectProject = actions.root.onSelectProject,
                    onRetryProjects = actions.root.onRetryProjects,
                    noProjectText = stringResource(R.string.plans_no_project),
                ) {
                    PlanList(
                        plans = LoadViews.plans(state.planListState, state.planDirPath),
                        sequences = LoadViews.sequences(state.sequenceListState, state.planDirPath),
                        collapsedLaneIds = state.homeState.collapsedLanes,
                        onToggleLane = actions.root.onToggleLane,
                        onOpen = actions.root.onOpenPlan,
                        onSpawn = actions.root.onSpawnForPlan,
                        taskLinks = actions.root.taskLinks,
                        onRefresh = actions.root.onRefreshPlanBoard,
                        write = state.planWriteState,
                        onDismissWrite = actions.root.onDismissPlanWrite,
                        onCreate = actions.root.onCreatePlan,
                        lanes = actions.root.lanes,
                        cleanup = state.cleanupState,
                    )
                }

                HomeTab.Time -> TimeScreen(
                    ask = state.timeAsk,
                    view = LoadViews.time(state.timeState, state.timeAsk),
                    onAsk = actions.root.onAskTime,
                    onFetch = actions.root.onFetchTime,
                )

                HomeTab.Contexts -> ProjectScoped(
                    projects = LoadViews.projects(state.projectsState),
                    project = state.project,
                    onSelectProject = actions.root.onSelectProject,
                    onRetryProjects = actions.root.onRetryProjects,
                    noProjectText = stringResource(R.string.contexts_no_project),
                ) {
                    ContextList(
                        contexts = LoadViews.contexts(state.contextListState, state.contextProjectId),
                        onOpen = actions.root.onOpenContext,
                        onRefresh = actions.root.onRefreshContexts,
                    )
                }
            }
        }
    }
}

/** The root chrome shared by the root surfaces and the tablet session panes. */
@Composable
internal fun HomeAppBar(
    linkState: LinkState,
    homeTab: HomeTab,
    notificationsEnabled: Boolean,
    onSelectHomeTab: (HomeTab) -> Unit,
    onLinkClick: () -> Unit,
    onToggleNotifications: () -> Unit,
    onExportLogs: () -> Unit,
    compact: Boolean = false,
) {
    HelmAppBar(
        title = stringResource(R.string.app_name),
        linkState = linkState,
        contextLabel = stringResource(homeTab.labelRes),
        contextMenuItems = HomeTab.entries.map {
            ContextMenuItem(stringResource(it.labelRes), it.glyphRes)
        },
        onSelectContextItem = { onSelectHomeTab(HomeTab.entries[it]) },
        onLinkClick = onLinkClick,
        settings = SettingsMenuActions(
            notificationsEnabled = notificationsEnabled,
            onToggleNotifications = onToggleNotifications,
            onExportLogs = onExportLogs,
            onOpenDesktops = onLinkClick,
        ),
        compact = compact,
    )
}
