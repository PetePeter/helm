package com.potatomotato.helm.ui

import androidx.activity.compose.BackHandler
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
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.sessions.SessionRowText
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.sessions.SessionRows
import com.potatomotato.helm.ui.rememberEtaNow
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
    BackHandler(onBack = actions.session.onBackToList)
    val currentOpenId = open.id
    val swipePreviewVisible = home.sessionSwipeDirection == 0 && kotlin.math.abs(state.sessionSwipeOffset.value) > 8f
    val pickerVisible = swipePreviewVisible && home.sessionTab == SessionTab.Chat
    val etas = remember(open) { listOfNotNull(open.eta) }
    val nowMs = rememberEtaNow(etas)
    Box(Modifier.fillMaxSize()) {
        val pickerFocusRequester = remember { FocusRequester() }
        LaunchedEffect(swipePreviewVisible, home.sessionTab) {
            if (swipePreviewVisible && home.sessionTab == SessionTab.Chat) pickerFocusRequester.requestFocus()
        }
        if (pickerVisible) {
            SessionSwipePicker(
                sessions = state.listedSessions,
                unread = state.unreadCounts,
                selectedId = home.sessionSwipeTargetId ?: currentOpenId,
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
                sessionName = listOf(targetSession.name, targetSession.statusIcons(nowMs))
                    .filter { it.isNotEmpty() }.joinToString("  "),
                mission = targetSession.mission,
                details = sessionHeaderDetails(targetSession, nowMs),
                context = state.contextHistories[targetSession.id],
                activity = targetSession.activity,
                linkState = state.linkState,
                tab = home.sessionTab,
                onSelectTab = actions.session.onSelectTab,
                onBack = actions.session.onBackToList,
                onOverflow = actions.session.onOverflow,
            ) {
                state.saveableStateHolder.SaveableStateProvider("session-tab:${targetSession.id}") {
                    SessionTabBody(
                        state = state,
                        actions = actions,
                        session = targetSession,
                        onSwipeSession = if (targetSessionId == currentOpenId && home.sessionSwipeDirection == 0) ({ step ->
                            if (home.sessionSwipeDirection == 0 && !state.edgeBounce.isRunning) {
                                actions.session.onSwipeSession(targetSessionId, step)
                            } else false
                        }) else null,
                        earlierUnread = neighbors.earlierSessions,
                        laterUnread = neighbors.laterSessions,
                    )
                }
            }
        }
    }
}

/** Reuse the session row's status and branch wording in the open-session header. */
@Composable
internal fun sessionHeaderDetails(session: HelmSession, nowMs: Long): String {
    val labels = SessionRowText.Labels(
        working = stringResource(R.string.sessions_sub_working),
        waitingApproval = stringResource(R.string.sessions_sub_waiting),
        idle = stringResource(R.string.sessions_sub_idle),
    )
    val status = SessionRowText.subLine(
        activity = session.activity,
        cliTypeName = session.cliTypeName,
        age = SessionRowText.relativeTime(session.lastActiveAtEpochMs, nowMs),
        labels = labels,
    )
    val eta = SessionRowText.etaHeaderLabel(session.eta, nowMs)?.let { label ->
        val time = stringResource(
            if (label.overdue) R.string.sessions_eta_header_overdue else R.string.sessions_eta_header_left,
            label.minutes,
        )
        val range = if (label.rangeStartMinutes != null && label.rangeEndMinutes != null) {
            stringResource(R.string.sessions_eta_header_range, label.rangeStartMinutes, label.rangeEndMinutes)
        } else null
        listOfNotNull(time, range).joinToString(" ")
    }
    return listOfNotNull(
        eta,
        status,
        session.gitBranch?.let { stringResource(R.string.sessions_git_branch, it) },
    ).joinToString("  ·  ")
}
