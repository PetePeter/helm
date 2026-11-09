package com.potatomotato.helm.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.LoadViews
import com.potatomotato.helm.ui.artifacts.ArtifactsScreen
import com.potatomotato.helm.ui.components.LoadNote
import com.potatomotato.helm.ui.sessions.SessionRowText
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.plans.PlanList
import com.potatomotato.helm.ui.sequences.SequenceList
import com.potatomotato.helm.ui.sessions.SessionRows
import com.potatomotato.helm.ui.sessions.SessionSwipePicker

internal const val SESSION_SWITCH_MS = 220

/**
 * The session's tabs share one bar and one body. Sheet keeps this surface under
 * its scrim so its actions retain their session target. A swipe only picks a
 * session after the chat tab supplies a completed horizontal gesture.
 */
@Composable
internal fun PhoneSessionContent(state: PhoneScaffoldState, actions: PhoneScaffoldActions) {
    val open = state.open ?: return
    val home = state.homeState
    val currentOpenId = open.id
    Box(Modifier.fillMaxSize()) {
        val swipePreviewVisible = home.sessionSwipeDirection == 0 && kotlin.math.abs(state.sessionSwipeOffset.value) > 8f
        val pickerFocusRequester = remember { FocusRequester() }
        LaunchedEffect(swipePreviewVisible, home.sessionTab) {
            if (swipePreviewVisible && home.sessionTab == SessionTab.Chat) pickerFocusRequester.requestFocus()
        }
        if (swipePreviewVisible && home.sessionTab == SessionTab.Chat) {
            SessionSwipePicker(
                sessions = state.listedSessions,
                unread = state.unreadCounts,
                selectedId = home.sessionSwipeTargetId ?: currentOpenId,
                selectedMarkerAtEnd = state.sessionSwipeOffset.value < 0f,
                onSelect = home::updateSwipeTarget,
                modifier = Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(0.58f)
                    .align(if (state.sessionSwipeOffset.value < 0f) Alignment.CenterEnd else Alignment.CenterStart)
                    .focusRequester(pickerFocusRequester)
                    .focusable()
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown || state.listedSessionIds.isEmpty()) return@onPreviewKeyEvent false
                        val currentIndex = state.listedSessionIds.indexOf(home.sessionSwipeTargetId ?: currentOpenId)
                        val nextIndex = when (event.key) {
                            Key.DirectionUp -> (currentIndex - 1).coerceAtLeast(0)
                            Key.DirectionDown -> (currentIndex + 1).coerceAtMost(state.listedSessionIds.lastIndex)
                            else -> return@onPreviewKeyEvent false
                        }
                        home.updateSwipeTarget(state.listedSessionIds[nextIndex])
                        true
                    },
            )
        }
        AnimatedContent(
            targetState = currentOpenId,
            modifier = Modifier.fillMaxSize(),
            transitionSpec = {
                if (home.sessionSwipeDirection == 0) {
                    EnterTransition.None togetherWith ExitTransition.None
                } else {
                    slideInHorizontally(
                        initialOffsetX = { -home.sessionSwipeDirection * it },
                        animationSpec = tween(SESSION_SWITCH_MS),
                    ) togetherWith slideOutHorizontally(
                        targetOffsetX = { home.sessionSwipeDirection * it },
                        animationSpec = tween(SESSION_SWITCH_MS),
                    )
                }
            },
            label = "session-horizontal-slide",
        ) { targetSessionId ->
            val targetSession = state.sessions.firstOrNull { it.id == targetSessionId } ?: return@AnimatedContent
            val isIncoming = targetSessionId == currentOpenId
            val neighbors = SessionRows.unreadNeighbors(state.listedSessionIds, targetSessionId, state.unreadCounts)
            SessionTabScaffold(
                modifier = Modifier.graphicsLayer {
                    translationX = state.edgeBounce.value + if (home.sessionSwipeDirection == 0 || !isIncoming) state.sessionSwipeOffset.value else 0f
                    shape = RoundedCornerShape(18.dp)
                    clip = true
                },
                // The same status icons as the list row, after the name.
                sessionName = listOf(targetSession.name, targetSession.statusIcons(System.currentTimeMillis()))
                    .filter { it.isNotEmpty() }.joinToString("  "),
                mission = targetSession.mission,
                details = sessionHeaderDetails(targetSession),
                context = state.contextHistories[targetSession.id],
                activity = targetSession.activity,
                linkState = state.linkState,
                tab = home.sessionTab,
                onSelectTab = actions.session.onSelectTab,
                onBack = actions.session.onBackToList,
                onOverflow = actions.session.onOverflow,
            ) {
                when (home.sessionTab) {
                    SessionTab.Chat -> PhoneChatContent(
                        state = state,
                        actions = actions,
                        sessionId = targetSession.id,
                        onSwipeSession = if (targetSessionId == currentOpenId && home.sessionSwipeDirection == 0) ({ step ->
                            if (home.sessionSwipeDirection == 0 && !state.edgeBounce.isRunning) {
                                actions.session.onSwipeSession(targetSessionId, step)
                            } else false
                        }) else null,
                        earlierUnread = neighbors.earlierSessions,
                        laterUnread = neighbors.laterSessions,
                    )

                    SessionTab.Artifacts -> ArtifactsScreen(
                        state = state.artifactList,
                        capabilities = state.capabilities,
                        onOpen = actions.session.onOpenArtifact,
                        onNew = actions.session.onNewArtifact,
                    )

                    // Reuse the root Plans board in this session's working
                    // directory, with no project picker: the session is its scope.
                    // A session without a directory has no board to load.
                    SessionTab.Plans -> if (state.planDirPath == null) {
                        LoadNote(stringResource(R.string.plans_no_session_directory))
                    } else {
                        PlanList(
                            plans = LoadViews.plans(state.planListState, state.planDirPath),
                            sequences = LoadViews.sequences(state.sequenceListState, state.planDirPath),
                            collapsedLaneIds = home.collapsedLanes,
                            onToggleLane = actions.root.onToggleLane,
                            onOpen = actions.session.onOpenPlan,
                            onSpawn = actions.session.onSpawnForPlan,
                            taskLinks = actions.root.taskLinks,
                            onRefresh = actions.session.onRefreshPlanBoard,
                            write = state.planWriteState,
                            onDismissWrite = actions.session.onDismissPlanWrite,
                            onCreate = actions.session.onCreatePlan,
                        )
                    }

                    SessionTab.Sequences -> if (state.planDirPath == null) {
                        LoadNote(stringResource(R.string.sequences_no_session_directory))
                    } else {
                        SequenceList(
                            sequences = LoadViews.sequences(state.sequenceListState, state.planDirPath),
                            onOpen = actions.session.onOpenSequence,
                            onRefresh = actions.session.onRefreshLanes,
                            cleanup = state.cleanupState,
                            write = state.planWriteState,
                            onDismissWrite = actions.session.onDismissPlanWrite,
                            onCreate = actions.session.onCreateSequence,
                            onClearUnused = actions.session.onClearUnused,
                        )
                    }
                }
            }
        }
    }
}

/** Reuse the session row's status and branch wording in the open-session header. */
@Composable
internal fun sessionHeaderDetails(session: HelmSession): String {
    val labels = SessionRowText.Labels(
        working = stringResource(R.string.sessions_sub_working),
        waitingApproval = stringResource(R.string.sessions_sub_waiting),
        idle = stringResource(R.string.sessions_sub_idle),
    )
    val now = System.currentTimeMillis()
    val status = SessionRowText.subLine(
        activity = session.activity,
        cliTypeName = session.cliTypeName,
        age = SessionRowText.relativeTime(session.lastActiveAtEpochMs, now),
        labels = labels,
    )
    return listOfNotNull(
        status,
        session.gitBranch?.let { stringResource(R.string.sessions_git_branch, it) },
    ).joinToString("  ·  ")
}
