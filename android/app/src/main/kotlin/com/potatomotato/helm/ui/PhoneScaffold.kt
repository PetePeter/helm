package com.potatomotato.helm.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.activity.compose.BackHandler
import android.app.Activity
import android.widget.Toast
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ArtifactRules
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.AttachmentUploadState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.CleanupState
import com.potatomotato.helm.data.ContextDetail
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.ContextList
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.data.HelmDirectory
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.PlanContextRefs
import com.potatomotato.helm.data.PlanDetail
import com.potatomotato.helm.data.PlanList
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.Reach
import com.potatomotato.helm.data.SequenceDetail
import com.potatomotato.helm.data.SequenceList
import com.potatomotato.helm.ui.sequences.LaneTools
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.ShareState
import com.potatomotato.helm.data.Snapshot
import com.potatomotato.helm.data.SpawnMachine
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.TimeAsk
import com.potatomotato.helm.data.TimeState
import com.potatomotato.helm.data.UploadSupport
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.data.PairedDesktop
import com.potatomotato.helm.ui.artifacts.ArtifactEdit
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.operator.OperatorSummary
import com.potatomotato.helm.ui.plans.PlanDetailActions
import com.potatomotato.helm.ui.plans.TaskLinks
import com.potatomotato.helm.voice.VoiceCallService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.LoadViews
/** Typed render input for the phone shell; all client requests are supplied as actions. */
internal data class PhoneScaffoldState(
    val modifier: Modifier,
    val saveableStateHolder: SaveableStateHolder,
    val homeState: HelmHomeState,
    val open: HelmSession?,
    val sessions: List<HelmSession>,
    val threads: Map<String, List<com.potatomotato.helm.data.ChatMessage>>,
    val pulls: Map<String, PullState>,
    val listedSessions: List<HelmSession>,
    val listedSessionIds: List<String>,
    val contextHistories: Map<String, ContextHistory>,
    val linkState: LinkState,
    val reach: Reach,
    val unreadCounts: Map<String, Int>,
    val capabilities: Capabilities,
    val desktops: List<PairedDesktop>,
    val operator: OperatorSummary,
    val liveCall: VoiceCallService.Call?,
    val notificationsEnabled: Boolean,
    val snapshot: Snapshot,
    val requestedLines: Int,
    val directories: List<HelmDirectory>,
    val directoriesError: String?,
    val clis: List<HelmCli>,
    val spawnInFlight: Boolean,
    val spawnMachines: List<SpawnMachine>,
    val projectsState: ProjectList,
    val project: HelmProject?,
    val planDirPath: String?,
    val contextProjectId: String?,
    val planListState: PlanList,
    val planDetailState: PlanDetail,
    val planContextsState: PlanContextRefs,
    val sequenceListState: SequenceList,
    val sequenceDetailState: SequenceDetail,
    val planWriteState: PlanWrite,
    val cleanupState: CleanupState,
    val contextListState: ContextList,
    val contextDetailState: ContextDetail,
    val timeState: TimeState,
    val timeAsk: TimeAsk,
    val artifactList: ArtifactList,
    val chat: PhoneChatState,
    val artifactRead: ArtifactRead,
    val artifactSave: ArtifactSave,
    val artifactPulls: Map<String, PullState>,
    val stagedAttachments: List<StagedAttachment>,
    val attachmentErrors: Map<String, String>,
    val uploadStates: Map<String, AttachmentUploadState>,
    val attachSupport: UploadSupport,
    val listedArtifacts: List<HelmArtifact>,
    val edit: ArtifactEdit?,
    val sessionSwipeOffset: Animatable<Float, AnimationVector1D>,
    val edgeBounce: Animatable<Float, AnimationVector1D>,
    val chatAttachSession: HelmSession?,
    val shareState: ShareState,
)

/** Callback surface for phone renderers. This keeps request ownership in HelmHome. */
internal data class PhoneScaffoldActions(
    val root: PhoneRootActions,
    val destination: PhoneDestinationActions,
    val session: PhoneSessionActions,
    val chat: PhoneChatActions,
    val overlay: PhoneOverlayActions,
)

/** Dependencies needed to build UI callbacks while request ownership stays outside renderers. */
internal data class PhoneActionContext(
    val client: com.potatomotato.helm.link.HelmClient,
    val appContext: android.content.Context,
    val scope: CoroutineScope,
    val homeState: HelmHomeState,
    val open: HelmSession?,
    val operator: OperatorSummary,
    val liveCall: VoiceCallService.Call?,
    val dial: (String) -> Unit,
    val requestedLines: Int,
    val planDirPath: String?,
    val planListState: PlanList,
    val sequenceListState: SequenceList,
    val planWriteState: PlanWrite,
    val capabilities: Capabilities,
    val notificationsEnabled: Boolean,
    val artifactRead: ArtifactRead,
    val edit: ArtifactEdit?,
    val uploadStates: Map<String, AttachmentUploadState>,
    val listedSessionIds: List<String>,
    val pickHomeTab: (HomeTab) -> Unit,
    val taskLinks: TaskLinks,
    val spawnForPlan: (HelmPlanSummary) -> Unit,
    val refreshPlanBoard: () -> Unit,
    val createPlan: (String, String, String?, Boolean) -> Unit,
    val refreshContextNodes: () -> Unit,
    val toggleLane: (String) -> Unit,
    val exportLogs: () -> Unit,
    val toThread: () -> Unit,
    val setTimeAsk: (TimeAsk) -> Unit,
    val openAttachment: (String, String) -> Unit,
    val artifactFiles: com.potatomotato.helm.save.AndroidArtifactFiles,
    val comfyGallerySaved: String,
    val comfyGallerySaveFailed: String,
    val launchChatAttach: (String, (String) -> Unit) -> Unit,
    val openStagedFile: (StagedAttachment) -> Unit,
    val launchCamera: () -> Unit,
    val launchGallery: () -> Unit,
    val launchFiles: () -> Unit,
    val launchReplace: (String) -> Unit,
)

internal fun phoneScaffoldActions(input: PhoneActionContext): PhoneScaffoldActions {
    val client = input.client
    val home = input.homeState
    val appContext = input.appContext
    val open = input.open
    val planDir = input.planDirPath

    val onPairDesktop = {
        HelmLinkService.forcePairingMode(appContext)
        home.destination = Destination.Pairing
    }

    return PhoneScaffoldActions(
        root = PhoneRootActions(
            onSelectHomeTab = input.pickHomeTab,
            onExportLogs = input.exportLogs,
            onToggleNotifications = {
                client.sessions.alerts.setEnabled(!input.notificationsEnabled)
            },
            onLinkClick = { home.destination = Destination.Desktops },
            onOpenOperatorChat = home::selectSession,
            // The operator's tasks are the plans of its own project.
            onOpenOperatorTasks = home::openOperatorTasks,
            // The operator's chat is right below, so ringing it turns that chat's composer into the call.
            onCallOperator = if (input.operator is OperatorSummary.On && input.liveCall == null) {
                { input.dial(input.operator.id) }
            } else null,
            onOpenSession = { session -> home.selectSession(session.id) },
            onLongPressSession = { session -> home.openSessionSheet(session.id) },
            onNewSession = home::openNewSessionForm,
            onPairDesktop = onPairDesktop,
            onSelectProject = { home.selectProject(it.id) },
            onRetryProjects = { client.workspace.refreshProjects() },
            onOpenPlan = { home.openPlan(it.id) },
            onSpawnForPlan = input.spawnForPlan,
            onRefreshPlanBoard = input.refreshPlanBoard,
            taskLinks = input.taskLinks,
            onDismissPlanWrite = client.plans.writes::dismiss,
            onCreatePlan = input.createPlan,
            onToggleLane = input.toggleLane,
            lanes = LaneTools(
                onCreateSequence = { title, mission -> planDir?.let { client.plans.createSequence(it, title, mission) } },
                onClearUnused = { planDir?.let(client.plans::clearUnused) },
                onOpenSequence = { home.openSequence(it.id) },
            ),
            onAskTime = input.setTimeAsk,
            onFetchTime = { client.workspace.refreshTime(it) },
            onOpenContext = { home.openContext(it.id) },
            onRefreshContexts = input.refreshContextNodes,
        ),
        destination = PhoneDestinationActions(
            onBackToThread = input.toThread,
            onPairDesktop = onPairDesktop,
            onRenameDesktop = HelmPairing::rename,
            onForgetDesktop = HelmPairing::forget,
            onUseDesktop = HelmPairing::use,
            onPairAt = HelmPairing::pairAt,
            onRestartDesktop = { resume ->
                val sent = appContext.getString(R.string.desktops_restart_sent)
                val issued = client.workspace.restartHelm(resume) { failure ->
                    input.scope.launch(Dispatchers.Main) {
                        Toast.makeText(appContext, failure ?: sent, Toast.LENGTH_LONG).show()
                    }
                }
                if (!issued) Toast.makeText(appContext, R.string.desktops_restart_unsent, Toast.LENGTH_LONG).show()
            },
            onRefreshMachine = { machineId ->
                client.workspace.refreshClis(machineId)
                client.workspace.refreshDirectories(machineId)
            },
            onSpawn = { dirPath, cliType, name, machineId ->
                // The route changes on the confirmed outcome; failure keeps the form choices visible.
                client.sessions.spawn(dirPath, cliType, name, home.planSpawn?.prompt, machineId)
            },
            onRetryDirectories = { machineId -> client.workspace.refreshDirectories(machineId) },
            onReadTerminal = { lines -> open?.let { client.sessions.readTerminal(it.id, lines) } },
            onRefreshPlan = {
                home.openPlanId?.let { planId ->
                    client.plans.readPlan(planId)
                    client.plans.refreshPlanContexts(planId)
                }
            },
            planDetailActions = planDetailActions(
                client = client,
                dirPath = planDir,
                planId = home.openPlanId,
                lanes = (LoadViews.sequences(input.sequenceListState, planDir) as? LoadView.Ready)?.data.orEmpty(),
                capabilities = input.capabilities,
                write = input.planWriteState,
            ),
            onRefreshSequence = { home.openSequenceId?.let { client.plans.readSequence(it) } },
            onDismissPlanWrite = client.plans.writes::dismiss,
            onEditSequence = { title, mission ->
                val id = home.openSequenceId
                if (planDir != null && id != null) client.plans.updateSequence(planDir, id, title, mission)
            },
            onDeleteSequence = {
                val id = home.openSequenceId
                if (planDir != null && id != null) client.plans.deleteSequence(planDir, id)
            },
            onRefreshContext = { home.openContextId?.let { client.plans.readContext(it) } },
            onLeaveEditor = {
                // Back undoes the edit without a wire call: create returns to
                // the list, while revise returns to the artifact being revised.
                // Leaving retires the stage only while nothing is being sent:
                // mid-upload the chips show failures, and the chain must finish.
                if (input.uploadStates.values.none { it is AttachmentUploadState.Uploading }) client.artifacts.uploads.clear()
                home.destination = if (home.editingArtifactId == null) Destination.Thread else Destination.ArtifactDetail
            },
            onAttachCamera = input.launchCamera,
            onAttachGallery = input.launchGallery,
            onAttachFiles = input.launchFiles,
            onOpenStaged = input.openStagedFile,
            onRemoveStaged = client.artifacts.uploads::unstage,
            onRetryStaged = { client.artifacts.retryArtifactUploads() },
            onDeleteExisting = { attachmentId ->
                val artifactId = home.editingArtifactId
                if (artifactId != null) {
                    // The cache prunes on Ok; re-pull to reconcile any other desktop changes.
                    client.artifacts.deleteArtifactAttachment(open?.id.orEmpty(), artifactId, attachmentId) {
                        client.artifacts.refreshArtifacts(open?.id.orEmpty())
                    }
                }
            },
            onReplaceExisting = input.launchReplace,
            onSubmitArtifact = { title, content, intent ->
                val intentSupported = input.capabilities.permits(SessionAction.SetArtifactIntent)
                if (input.edit is ArtifactEdit.New) {
                    // The staged keys ride create; uploads chain and the notice lands after the final commit.
                    client.artifacts.createArtifact(
                        open?.id.orEmpty(), title, content, client.artifacts.uploads.pendingKeys(),
                        intent.takeIf { intentSupported && it != com.potatomotato.helm.data.ArtifactIntent.Normal },
                    )
                } else {
                    val artifactId = home.editingArtifactId
                    if (artifactId != null && input.edit is ArtifactEdit.Revision) {
                        // A revise chains staged files through the same upload path as a create.
                        client.artifacts.reviseArtifact(
                            open?.id.orEmpty(), artifactId,
                            ArtifactRules.Revision(input.edit.artifact.title, input.edit.shown, title, content),
                            client.artifacts.uploads.pendingKeys(),
                            intent.takeIf { intentSupported && it != input.edit.intent },
                        )
                    }
                }
            },
            onArtifactPull = { version ->
                home.selectedSessionId?.let { session -> client.artifacts.readArtifact(session, home.openArtifactId!!, version) }
            },
            onReviseArtifact = {
                home.editingArtifactId = home.openArtifactId
                home.editingShown = when (val current = input.artifactRead) {
                    is ArtifactRead.Done -> current.read.content
                    is ArtifactRead.Refreshing -> current.cached.content
                    else -> null
                }
                home.destination = Destination.ArtifactEditor
            },
            onDownloadArtifact = {
                home.selectedSessionId?.let { session -> client.artifacts.downloadArtifact(session, home.openArtifactId!!, null) }
            },
            onDownloadAttachment = { attachment ->
                home.selectedSessionId?.let { session ->
                    client.artifacts.downloadArtifactAttachment(session, home.openArtifactId!!, attachment)
                }
            },
            onOpenAttachment = input.openAttachment,
            onDeleteArtifact = {
                home.selectedSessionId?.let { session -> client.artifacts.deleteArtifact(session, home.openArtifactId!!) }
            },
        ),
        session = PhoneSessionActions(
            onBackToList = home::clearSessionSelection,
            onSelectTab = home::chooseSessionTab,
            onOverflow = { home.destination = Destination.Sheet },
            onSwipeSession = { targetId, step ->
                home.swipeSession(input.listedSessionIds, targetId, step, canSwipe = true)
            },
            onOpenArtifact = { home.selectArtifact(it.id) },
            onPreviewArtifact = { artifact ->
                home.openArtifactId = artifact.id
                home.selectedSessionId?.let { session -> client.artifacts.readArtifact(session, artifact.id, version = null) }
            },
            onNewArtifact = home::startArtifactCreate,
            onOpenPlan = { home.openPlan(it.id) },
            onSpawnForPlan = input.spawnForPlan,
            onRefreshPlanBoard = input.refreshPlanBoard,
            onDismissPlanWrite = client.plans.writes::dismiss,
            onCreatePlan = input.createPlan,
        ),
        chat = phoneChatActions(
            PhoneChatActionContext(
                client = client,
                appContext = appContext,
                scope = input.scope,
                home = home,
                requestedLines = input.requestedLines,
                dial = input.dial,
                artifactFiles = input.artifactFiles,
                comfyGallerySaved = input.comfyGallerySaved,
                comfyGallerySaveFailed = input.comfyGallerySaveFailed,
                openAttachment = input.openAttachment,
                launchAttach = input.launchChatAttach,
            ),
        ),
        overlay = PhoneOverlayActions(
            onBackToThread = input.toThread,
            onSessionAction = { action ->
                if (open != null) {
                    val handled = applyPhoneSheetAction(
                        state = home,
                        action = action,
                        sessionId = open.id,
                        requestedLines = input.requestedLines,
                        readTerminal = client.sessions::readTerminal,
                        dial = input.dial,
                    )
                    if (!handled) {
                        home.destination = when (action) {
                            SessionAction.Spawn -> Destination.Spawn
                            SessionAction.Compact -> Destination.Thread.also { client.sessions.compact(open.id) }
                            SessionAction.Clear -> Destination.Thread.also { client.sessions.clear(open.id) }
                            SessionAction.HelmCompact -> Destination.Thread.also { client.sessions.quickCompact(open.id) }
                            SessionAction.Clone -> Destination.Thread.also { client.sessions.cloneSession(open.id) }
                            SessionAction.Stop -> Destination.Thread.also { client.sessions.stop(open.id) }
                            SessionAction.KeepWarmOn -> Destination.Thread.also { client.sessions.keepWarm(open.id, true) }
                            SessionAction.KeepWarmOff -> Destination.Thread.also { client.sessions.keepWarm(open.id, false) }
                            SessionAction.Freeze -> Destination.Thread.also { client.sessions.setFrozen(open.id, true) }
                            SessionAction.Unfreeze -> Destination.Thread.also { client.sessions.setFrozen(open.id, false) }
                            SessionAction.Close -> Destination.Thread.also { client.sessions.closeSession(open.id) }
                            // Rename carries a name to its callback; artifact actions have visible
                            // rows on the artifacts tab and the screens beneath it.
                            SessionAction.Rename -> Destination.Thread
                            else -> Destination.Thread
                        }
                    }
                }
            },
            onRenameSession = { name ->
                open?.let { client.sessions.renameSession(it.id, name) }
                // The notice bar and refreshed app bar both land on the thread surface.
                home.toThread()
            },
            onSwitchCli = { cliType ->
                open?.let { client.sessions.switchCli(it.id, cliType) }
                home.toThread()
            },
            onBackground = {
                home.leaving = false
                // Background the task instead of finishing it so Recents and the link survive.
                (appContext as? Activity)?.moveTaskToBack(true)
            },
            onQuit = {
                home.leaving = false
                // Shutdown ordering and the always-end guarantee live in quitHelmApp;
                // finishAndRemoveTask also drops the stale Recents entry.
                quitHelmApp(
                    stopLan = HelmPairing::stopLan,
                    stopLinkService = { HelmLinkService.stop(appContext) },
                    finish = { (appContext as? Activity)?.finishAndRemoveTask() },
                    endProcess = { android.os.Process.killProcess(android.os.Process.myPid()) },
                )
            },
            onExitDismiss = { home.leaving = false },
            onContinueShare = client.artifacts::continueShareWait,
            onCancelShare = client.artifacts::cancelShare,
        ),
    )
}

/** Session action callbacks with navigation effects that also issue a wire request. */
internal fun applyPhoneSheetAction(
    state: HelmHomeState,
    action: SessionAction,
    sessionId: String,
    requestedLines: Int,
    readTerminal: (String, Int) -> Unit,
    dial: (String) -> Unit,
): Boolean = when (action) {
    SessionAction.Snapshot -> {
        // Pull at the count already shown by the sheet (the smallest default),
        // so an empty terminal screen does not make the user choose twice.
        state.openSnapshot()
        readTerminal(sessionId, requestedLines)
        true
    }
    SessionAction.Call -> {
        // Preserve the old callback order: select chat, dial, then leave the sheet.
        state.prepareSheetCall()
        dial(sessionId)
        state.toThread()
        true
    }
    else -> false
}

internal data class PhoneRootActions(
    val onSelectHomeTab: (HomeTab) -> Unit,
    /** Lane management for both plan boards (home and in-session) — one scope, one toolset. */
    val lanes: LaneTools,
    val onExportLogs: () -> Unit,
    val onToggleNotifications: () -> Unit,
    val onLinkClick: () -> Unit,
    val onOpenOperatorChat: (String) -> Unit,
    val onOpenOperatorTasks: (String) -> Unit,
    val onCallOperator: (() -> Unit)?,
    val onOpenSession: (HelmSession) -> Unit,
    val onLongPressSession: (HelmSession) -> Unit,
    val onNewSession: () -> Unit,
    val onPairDesktop: () -> Unit,
    val onSelectProject: (HelmProject) -> Unit,
    val onRetryProjects: () -> Unit,
    val onOpenPlan: (HelmPlanSummary) -> Unit,
    val onSpawnForPlan: (HelmPlanSummary) -> Unit,
    val onRefreshPlanBoard: () -> Unit,
    val taskLinks: com.potatomotato.helm.ui.plans.TaskLinks,
    val onDismissPlanWrite: () -> Unit,
    val onCreatePlan: (String, String, String?, Boolean) -> Unit,
    val onToggleLane: (String) -> Unit,
    val onAskTime: (TimeAsk) -> Unit,
    val onFetchTime: (TimeAsk) -> Unit,
    val onOpenContext: (HelmContext) -> Unit,
    val onRefreshContexts: () -> Unit,
)

internal data class PhoneDestinationActions(
    val onBackToThread: () -> Unit,
    val onPairDesktop: () -> Unit,
    val onRenameDesktop: (String, String) -> Unit,
    val onForgetDesktop: (String) -> Unit,
    val onUseDesktop: (String) -> Unit,
    val onPairAt: (String) -> Unit,
    val onRestartDesktop: (Boolean) -> Unit,
    val onRefreshMachine: (String?) -> Unit,
    val onSpawn: (String, String, String, String?) -> Unit,
    val onRetryDirectories: (String?) -> Unit,
    val onReadTerminal: (Int) -> Unit,
    val onRefreshPlan: () -> Unit,
    val planDetailActions: PlanDetailActions,
    val onRefreshSequence: () -> Unit,
    val onDismissPlanWrite: () -> Unit,
    val onEditSequence: (String, String) -> Unit,
    val onDeleteSequence: () -> Unit,
    val onRefreshContext: () -> Unit,
    val onLeaveEditor: () -> Unit,
    val onAttachCamera: () -> Unit,
    val onAttachGallery: () -> Unit,
    val onAttachFiles: () -> Unit,
    val onOpenStaged: (StagedAttachment) -> Unit,
    val onRemoveStaged: (String) -> Unit,
    val onRetryStaged: (String) -> Unit,
    val onDeleteExisting: (String) -> Unit,
    val onReplaceExisting: (String) -> Unit,
    val onSubmitArtifact: (String, String, com.potatomotato.helm.data.ArtifactIntent) -> Unit,
    val onArtifactPull: (Int?) -> Unit,
    val onReviseArtifact: () -> Unit,
    val onDownloadArtifact: () -> Unit,
    val onDownloadAttachment: (com.potatomotato.helm.data.HelmArtifactAttachment) -> Unit,
    val onOpenAttachment: (String, String) -> Unit,
    val onDeleteArtifact: () -> Unit,
)

internal data class PhoneSessionActions(
    val onBackToList: () -> Unit,
    val onSelectTab: (SessionTab) -> Unit,
    val onOverflow: () -> Unit,
    val onSwipeSession: (String, Int) -> Boolean,
    val onOpenArtifact: (HelmArtifact) -> Unit,
    /** Strip card tap: show its body inline without leaving the tab. */
    val onPreviewArtifact: (HelmArtifact) -> Unit,
    val onNewArtifact: () -> Unit,
    val onOpenPlan: (HelmPlanSummary) -> Unit,
    val onSpawnForPlan: (HelmPlanSummary) -> Unit,
    val onRefreshPlanBoard: () -> Unit,
    val onDismissPlanWrite: () -> Unit,
    val onCreatePlan: (String, String, String?, Boolean) -> Unit,
)

internal data class PhoneOverlayActions(
    val onBackToThread: () -> Unit,
    val onSessionAction: (SessionAction) -> Unit,
    val onRenameSession: (String) -> Unit,
    val onSwitchCli: (String) -> Unit,
    val onBackground: () -> Unit,
    val onQuit: () -> Unit,
    val onExitDismiss: () -> Unit,
    val onContinueShare: (Long) -> Unit,
    val onCancelShare: (Long) -> Unit,
)

/** The phone chooses one full-screen route; HelmHome owns shared overlays above either shell. */
@Composable
internal fun PhoneScaffold(state: PhoneScaffoldState, actions: PhoneScaffoldActions) {
    val home = state.homeState
    val atRoot = state.open == null && home.destination == Destination.Thread
    Box(modifier = state.modifier.fillMaxSize()) {
        when (phoneScaffoldSurface(home.destination, hasOpenSession = state.open != null)) {
            PhoneScaffoldSurface.FullScreen -> PhoneDestinationContent(state, actions)
            PhoneScaffoldSurface.Root -> PhoneRootContent(state, actions)
            PhoneScaffoldSurface.Session -> PhoneSessionContent(state, actions)
        }

        // Back at the true root is gated, not merely last: otherwise it would
        // swallow in-app BackHandlers and offer to quit halfway down the app.
        // Backgrounding keeps the foreground service, BLE link and notifications
        // alive; quitting drops them, so a stray Back must not choose silently.
        // Every root tab shares this exit question after HomeTabHistory is retraced.
        BackHandler(enabled = atRoot) { home.backAtRoot(home.leaving) }
        // A notification can navigate out from under the question; clear it with its screen.
        LaunchedEffect(atRoot) { if (!atRoot) home.leaving = false }
    }
}

