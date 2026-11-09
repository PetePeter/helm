package com.potatomotato.helm.ui

import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.ui.plans.PlanDetailActions
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.ui.components.LoadViews
import com.potatomotato.helm.ui.artifacts.ArtifactDetailScreen
import com.potatomotato.helm.ui.artifacts.ArtifactEditorScreen
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.detailTitle
import com.potatomotato.helm.ui.contexts.ContextDetail
import com.potatomotato.helm.ui.control.SnapshotScreen
import com.potatomotato.helm.ui.control.SpawnScreen
import com.potatomotato.helm.ui.pairing.AwaitingDesktopScreen
import com.potatomotato.helm.ui.pairing.DesktopsScreen
import com.potatomotato.helm.ui.sequences.SequenceDetail

internal enum class PhoneScaffoldSurface { Root, Session, FullScreen }

/** Root destinations stay reachable without a session; session routes wait for their row. */
internal fun phoneScaffoldSurface(destination: Destination, hasOpenSession: Boolean): PhoneScaffoldSurface = when {
    destination == Destination.Desktops || destination == Destination.Pairing || destination == Destination.Spawn ||
        destination == Destination.PlanDetail || destination == Destination.SequenceDetail || destination == Destination.ContextDetail ->
        PhoneScaffoldSurface.FullScreen
    !hasOpenSession -> PhoneScaffoldSurface.Root
    destination == Destination.Snapshot || destination == Destination.ArtifactDetail || destination == Destination.ArtifactEditor ->
        PhoneScaffoldSurface.FullScreen
    else -> PhoneScaffoldSurface.Session
}

/** Draw the full-screen route selected by [phoneScaffoldSurface]. */
@Composable
internal fun PhoneDestinationContent(state: PhoneScaffoldState, actions: PhoneScaffoldActions) {
    val home = state.homeState
    val action = actions.destination
    when (home.destination) {
        // The list can open Desktops without selecting a session.
        Destination.Desktops -> {
            BackHandler(onBack = action.onBackToThread)
            DesktopsScreen(
                desktops = state.desktops,
                linkState = state.linkState,
                onRename = action.onRenameDesktop,
                onForget = action.onForgetDesktop,
                onUse = action.onUseDesktop,
                onPairDesktop = action.onPairDesktop,
                onRestart = action.onRestartDesktop,
                onBack = action.onBackToThread,
            )
        }

        // Pairing is also sessionless. A desktop connecting during the wait is
        // rendered by HelmRoot's Handshaking/Comparing interstitial above this
        // screen, so this branch simply stops drawing without navigating away.
        Destination.Pairing -> {
            BackHandler(onBack = action.onBackToThread)
            AwaitingDesktopScreen(
                linkState = state.linkState,
                onReadvertise = action.onPairDesktop,
                onPairAt = action.onPairAt,
                onBack = action.onBackToThread,
            )
        }

        // Spawn is reachable from the root list's New session action.
        Destination.Spawn -> {
            BackHandler(onBack = action.onBackToThread)
            SpawnScreen(
                directories = state.directories,
                clis = state.clis,
                directoriesError = state.directoriesError,
                sessions = state.sessions,
                linkState = state.linkState,
                spawnInFlight = state.spawnInFlight,
                machines = state.spawnMachines,
                onMachine = action.onRefreshMachine,
                onSpawn = action.onSpawn,
                onRetryDirectories = action.onRetryDirectories,
                onBack = action.onBackToThread,
                plan = home.planSpawn,
            )
        }

        // Plan, sequence and context details are reachable from root tabs and
        // from a session's Plans tab; Back returns to that thread surface. Their
        // link badge matters while they wait on a desktop answer, especially if
        // the link drops while the user stays on the detail screen.
        Destination.PlanDetail -> {
            BackHandler(onBack = action.onBackToThread)
            val plan = LoadViews.plan(state.planDetailState, home.openPlanId)
            Column(modifier = Modifier.fillMaxSize()) {
                HelmAppBar(
                    title = detailTitle(plan, stringResource(R.string.plan_detail_title)) { it.title },
                    linkState = state.linkState,
                    onBack = action.onBackToThread,
                )
                com.potatomotato.helm.ui.plans.PlanDetail(
                    plan = plan,
                    contexts = LoadViews.planContexts(state.planContextsState, home.openPlanId),
                    actions = action.planDetailActions,
                    onRefresh = action.onRefreshPlan,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Destination.SequenceDetail -> {
            BackHandler(onBack = action.onBackToThread)
            val sequence = LoadViews.sequence(state.sequenceDetailState, home.openSequenceId)
            Column(modifier = Modifier.fillMaxSize()) {
                HelmAppBar(
                    title = detailTitle(sequence, stringResource(R.string.sequence_detail_title)) { it.title },
                    linkState = state.linkState,
                    onBack = action.onBackToThread,
                )
                SequenceDetail(
                    sequence = sequence,
                    onRefresh = action.onRefreshSequence,
                    write = state.planWriteState,
                    onDismissWrite = action.onDismissPlanWrite,
                    onEdit = action.onEditSequence,
                    onDelete = action.onDeleteSequence,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Destination.ContextDetail -> {
            BackHandler(onBack = action.onBackToThread)
            val context = LoadViews.context(state.contextDetailState, home.openContextId)
            Column(modifier = Modifier.fillMaxSize()) {
                HelmAppBar(
                    title = detailTitle(context, stringResource(R.string.context_detail_title)) { it.title },
                    linkState = state.linkState,
                    onBack = action.onBackToThread,
                )
                ContextDetail(
                    context = context,
                    onRefresh = action.onRefreshContext,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Destination.Snapshot -> {
            BackHandler(onBack = action.onBackToThread)
            SnapshotScreen(
                snapshot = state.snapshot,
                requestedLines = state.requestedLines,
                linkState = state.linkState,
                onPull = action.onReadTerminal,
                onBack = action.onBackToThread,
            )
        }

        Destination.ArtifactEditor -> if (state.edit != null) {
            BackHandler(onBack = action.onLeaveEditor)
            ArtifactEditorScreen(
                edit = state.edit,
                linkState = state.linkState,
                staged = state.stagedAttachments,
                uploadStates = state.uploadStates,
                attachSupport = state.attachSupport,
                onAttachCamera = action.onAttachCamera,
                onAttachGallery = action.onAttachGallery,
                onAttachFiles = action.onAttachFiles,
                onOpenStaged = action.onOpenStaged,
                onRemoveStaged = action.onRemoveStaged,
                onRetryStaged = action.onRetryStaged,
                attachmentErrors = state.attachmentErrors,
                onDeleteExisting = action.onDeleteExisting,
                onReplaceExisting = action.onReplaceExisting,
                onSubmit = action.onSubmitArtifact,
                onBack = action.onLeaveEditor,
                manifestoSupported = state.capabilities.permits(com.potatomotato.helm.data.SessionAction.SetArtifactIntent),
            )
        } else {
            // The payload can disappear before its reset effect lands. Render
            // nothing until then, or the thread would flash into the editor.
            Unit
        }

        Destination.ArtifactDetail -> {
            BackHandler(onBack = action.onBackToThread)
            ArtifactDetailScreen(
                // The list row names the artifact while its body is still crossing the link.
                artifact = state.listedArtifacts.firstOrNull { it.id == home.openArtifactId },
                state = state.artifactRead,
                saveState = state.artifactSave,
                capabilities = state.capabilities,
                linkState = state.linkState,
                onPull = action.onArtifactPull,
                onRevise = action.onReviseArtifact,
                onDownload = action.onDownloadArtifact,
                attachmentPulls = state.artifactPulls,
                onDownloadAttachment = action.onDownloadAttachment,
                onOpenAttachment = action.onOpenAttachment,
                onDelete = action.onDeleteArtifact,
                onBack = action.onBackToThread,
            )
        }

        else -> Unit
    }
}

/**
 * The plan detail's write bundle (P-0812). Every action is a no-op without a
 * directory or an open plan, so the detail screen needs no null checks it cannot answer.
 */
internal fun planDetailActions(
    client: HelmClient,
    dirPath: String?,
    planId: String?,
    lanes: List<HelmPlanSequence>,
    capabilities: Capabilities,
    write: PlanWrite,
): PlanDetailActions {
    fun withPlan(action: (String, String) -> Unit): () -> Unit = {
        if (dirPath != null && planId != null) action(dirPath, planId)
    }
    return PlanDetailActions(
        lanes = lanes,
        capabilities = capabilities,
        write = write,
        onDismissWrite = client.plans.writes::dismiss,
        onEdit = { title, description -> withPlan { dir, id -> client.plans.updatePlan(dir, id, title, description) }() },
        onSetState = { status -> withPlan { dir, id -> client.plans.setPlanState(dir, id, status) }() },
        onAcceptSuggestion = withPlan { dir, id -> client.plans.acceptPlanSuggestion(dir, id) },
        onRejectSuggestion = withPlan { dir, id -> client.plans.rejectPlanSuggestion(dir, id) },
        onComplete = { documentation -> withPlan { dir, id -> client.plans.completePlan(dir, id, documentation) }() },
        onReopen = withPlan { dir, id -> client.plans.reopenPlan(dir, id) },
        onAssign = { laneId -> withPlan { dir, id -> client.plans.assignSequence(dir, id, laneId) }() },
        onDelete = withPlan { dir, id -> client.plans.deletePlan(dir, id) },
    )
}
