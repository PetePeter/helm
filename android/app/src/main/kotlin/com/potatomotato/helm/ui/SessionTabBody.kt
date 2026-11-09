package com.potatomotato.helm.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.artifacts.ArtifactsScreen
import com.potatomotato.helm.ui.components.LoadViews
import com.potatomotato.helm.ui.components.LoadNote
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.plans.PlanList
import com.potatomotato.helm.ui.sequences.SequenceList

/** The session tab body shared by phone and tablet shells. */
@Composable
internal fun SessionTabBody(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    session: HelmSession,
    onSwipeSession: ((Int) -> Boolean)?,
    earlierUnread: Int,
    laterUnread: Int,
) {
    when (state.homeState.sessionTab) {
        SessionTab.Chat -> PhoneChatContent(
            state = state,
            actions = actions,
            sessionId = session.id,
            onSwipeSession = onSwipeSession,
            earlierUnread = earlierUnread,
            laterUnread = laterUnread,
        )

        SessionTab.Artifacts -> ArtifactsScreen(
            state = state.artifactList,
            capabilities = state.capabilities,
            onOpen = actions.session.onOpenArtifact,
            onNew = actions.session.onNewArtifact,
        )

        // Reuse the root Plans board in this session's working directory, with no project picker.
        SessionTab.Plans -> if (state.planDirPath == null) {
            LoadNote(stringResource(R.string.plans_no_session_directory))
        } else {
            PlanList(
                plans = LoadViews.plans(state.planListState, state.planDirPath),
                sequences = LoadViews.sequences(state.sequenceListState, state.planDirPath),
                collapsedLaneIds = state.homeState.collapsedLanes,
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
