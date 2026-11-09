package com.potatomotato.helm.ui

import com.potatomotato.helm.data.ContextGraph
import com.potatomotato.helm.data.TimeAsk
import com.potatomotato.helm.data.TimePeriod
import android.widget.Toast
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.HelmApp
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.LogExport
import com.potatomotato.helm.log.LogExportResult
import com.potatomotato.helm.save.AndroidArtifactFiles
import com.potatomotato.helm.save.AndroidLogFiles
import com.potatomotato.helm.ui.artifacts.ArtifactEdit
import com.potatomotato.helm.ui.call.rememberDialer
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.ui.operator.operatorSummary
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.control.ActionNoticeBar
import com.potatomotato.helm.ui.operator.withoutOperator
import com.potatomotato.helm.ui.plans.TaskLinks
import com.potatomotato.helm.ui.plans.PlanScope
import com.potatomotato.helm.ui.plans.PlanSpawn
import com.potatomotato.helm.ui.tablet.LayoutChooser
import com.potatomotato.helm.ui.tablet.TabletLayout
import com.potatomotato.helm.ui.tablet.TabletScaffold
import androidx.compose.ui.input.key.type
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
@Composable
fun HelmHome(client: HelmClient = HelmPairing.client, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val saveableStateHolder = rememberSaveableStateHolder()
    val linkState by HelmLink.state.collectAsState()
    val sessions by client.sessions.state.sessions.collectAsState()
    val contextObservations by client.sessions.state.contextObservations.collectAsState()
    val reach by client.sessions.state.reach.collectAsState()
    val threads by client.sessions.chats.threads.collectAsState()
    val pulls by client.sessions.chats.pulls.collectAsState()
    val excludedComfyReferenceIds by client.sessions.chats.excludedComfyReferenceIds.collectAsState()
    val unreadCounts by client.sessions.chats.unreadCounts.collectAsState()
    val contextHistories = remember(threads, sessions, contextObservations) {
        sessions.mapNotNull { session ->
            ContextGraph.fromThread(
                thread = threads[session.id].orEmpty(),
                latest = session.context,
                observations = contextObservations[session.id].orEmpty(),
            )?.let { session.id to it }
        }.toMap()
    }
    val capabilities by client.workspace.capabilities.state.collectAsState()
    val snapshot by client.workspace.control.snapshot.collectAsState()
    val requestedLines by client.workspace.control.requestedLines.collectAsState()
    val notice by client.workspace.control.notice.collectAsState()
    val directories by client.workspace.control.directories.collectAsState()
    val directoriesError by client.workspace.control.directoriesError.collectAsState()
    val clis by client.workspace.control.clis.collectAsState()
    val createdSessionId by client.workspace.control.createdSessionId.collectAsState()
    val spawnInFlight by client.workspace.control.spawnInFlight.collectAsState()
    val spawnMachines by client.workspace.control.spawnMachines.collectAsState()
    val artifactList by client.artifacts.state.list.collectAsState()
    val artifactRead by client.artifacts.state.read.collectAsState()
    val artifactSave by client.artifacts.state.save.collectAsState()
    val artifactPulls by client.artifacts.state.attachmentPulls.pulls.collectAsState()
    val artifactLanding by client.workspace.control.artifactLanding.collectAsState()
    // The staged files of the artifact create in flight, and where each has got
    // to. Owned by the client, not the editor, for the same reason every
    // transfer on this link is: an upload outruns its screen.
    val stagedAttachments by client.artifacts.uploads.staged.collectAsState()
    val attachmentErrors by client.artifacts.state.attachmentErrors.collectAsState()
    val uploadStates by client.artifacts.uploads.states.collectAsState()
    val notificationsEnabled by client.sessions.alerts.enabled.collectAsState()
    val desktops by HelmPairing.desktops.collectAsState()
    val planListState by client.plans.state.list.collectAsState()
    val planDetailState by client.plans.state.detail.collectAsState()
    val planContextsState by client.plans.state.contextRefs.collectAsState()
    val sequenceListState by client.plans.sequences.list.collectAsState()
    val sequenceDetailState by client.plans.sequences.detail.collectAsState()
    val planWriteState by client.plans.writes.state.collectAsState()
    val cleanupState by client.plans.sequences.cleanup.collectAsState()
    val projectsState by client.plans.contexts.projects.collectAsState()
    val contextListState by client.plans.contexts.list.collectAsState()
    val contextDetailState by client.plans.contexts.detail.collectAsState()
    val timeState by client.workspace.time.state.collectAsState()
    // The Time tab's ask. Not saveable (a data class); losing the page on a
    // rotation only means landing back on this week's totals.
    var timeAsk by remember { mutableStateOf(TimeAsk(TimePeriod.Day, System.currentTimeMillis(), null)) }
    val homeState = rememberSaveable(saver = HelmHomeState.Saver) { HelmHomeState() }
    val sessionSwipeOffset = remember { Animatable(0f) }
    val edgeBounce = remember { Animatable(0f) }
    val density = LocalDensity.current
    LaunchedEffect(homeState.edgeBounceRequest) {
        if (homeState.edgeBounceRequest == 0) return@LaunchedEffect
        edgeBounce.snapTo(0f)
        val extent = with(density) { EDGE_BOUNCE_DISTANCE_DP.dp.toPx() } * homeState.edgeBounceDirection
        edgeBounce.animateTo(extent, animationSpec = tween(EDGE_BOUNCE_PULL_MS))
        edgeBounce.animateTo(
            targetValue = 0f,
            animationSpec = spring(dampingRatio = EDGE_BOUNCE_DAMPING, stiffness = EDGE_BOUNCE_STIFFNESS),
        )
    }
    LaunchedEffect(homeState.selectedSessionId, homeState.sessionSwipeDirection) {
        if (homeState.sessionSwipeDirection == 0) return@LaunchedEffect
        delay(SESSION_SWITCH_MS.toLong() + 50L)
        homeState.finishSwipeAnimation()
    }
    // The call connection is process-scoped; the visible session is its current
    // chat target, so changing sessions never tears down Telecom.
    val liveCall by VoiceCallService.call.collectAsState()
    val dial = rememberDialer()
    val pickHomeTab: (HomeTab) -> Unit = homeState::selectHomeTab
    val toggleLane: (String) -> Unit = homeState::toggleLane

    val operator = remember(sessions, threads) { operatorSummary(sessions, threads) }

    val open = sessions.firstOrNull { it.id == homeState.selectedSessionId }
    val listedSessions = remember(sessions) { withoutOperator(sessions) }
    val listedSessionIds = remember(listedSessions) { listedSessions.map { it.id } }
    // Keep the old non-empty guard so restore does not discard a selection before data arrives.
    homeState.clearMissingSession(open != null, sessions.isNotEmpty())

    // THE ONE PLACE SCOPE IS RESOLVED. Everything below — the effects that pull
    // and the composables that draw — works from these two values and never asks
    // again where they came from, which is what lets the plan board be ONE
    // screen: the root points it at the chosen project's canonical path, an open
    // session at its own working directory.
    //
    // Plans are project-scoped on the desktop (plan-manager resolves a dirPath to
    // its project), so one plan_summary with the project's canonical path answers
    // for the whole project. There is no fan-out over its directories.
    val listedProjects = when (val state = projectsState) {
        is ProjectList.Ready -> state.projects
        is ProjectList.Refreshing -> state.cached
        else -> emptyList()
    }
    // The chosen project, or the first one — a Plans tab that opens empty until
    // the user picks from a list of one is a step that answers nothing. The
    // CHOICE is still what is remembered; this is only the default.
    val project = listedProjects.firstOrNull { it.id == homeState.chosenProjectId } ?: listedProjects.firstOrNull()
    val planDirPath = PlanScope.resolve(open?.projectPath, project?.canonicalPath)
    val contextProjectId = project?.id

    // A downloaded artifact's bytes are not a save until they are on disk. The
    // device sink is the only Android-typed step in the artifacts slice; it
    // lives here at the UI edge, and its outcome is both the Save row's state
    // and the notice the user reads.
    // Hand a saved attachment to whatever the phone uses for that kind of file.
    // The grant is per-intent and read-only; a phone with no viewer for the type
    // says so on the notice bar rather than failing silently under the tap.
    val openAttachment: (String, String) -> Unit = remember(context) {
        { uri, mimeType ->
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(uri), mimeType)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(intent)
            } catch (error: ActivityNotFoundException) {
                client.workspace.control.noticed(
                    SessionAction.SaveArtifact,
                    ActionOutcome.Failed(context.getString(R.string.chat_attachment_no_viewer)),
                )
            }
        }
    }

    val artifactFiles = remember { AndroidArtifactFiles(context) }

    // The log export deliberately does NOT go over the link: the reports it
    // exists to serve are "it says Linked but nothing arrives", so an export
    // that needed the desktop would be broken in exactly the case it is for.
    // Strings are resolved here rather than in the callback — stringResource
    // reads the composition, which a click handler is no longer inside.
    val logFiles = remember { AndroidLogFiles(context) }
    val scope = rememberCoroutineScope()
    val comfyGallerySaved = stringResource(R.string.comfy_gallery_saved)
    val comfyGallerySaveFailed = stringResource(R.string.comfy_gallery_save_failed)
    val exportSaved = stringResource(R.string.logs_export_saved)
    val exportEmpty = stringResource(R.string.logs_export_empty)
    val exportFailed = stringResource(R.string.logs_export_failed)
    val exportLogs: () -> Unit = {
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                LogExport.export(HelmApp.logs?.snapshot().orEmpty(), logFiles)
            }
            Toast.makeText(
                context,
                when (result) {
                    is LogExportResult.Saved -> exportSaved.format(result.where)
                    LogExportResult.Empty -> exportEmpty
                    is LogExportResult.Failed -> exportFailed.format(result.reason)
                },
                Toast.LENGTH_LONG,
            ).show()
        }
        Unit
    }

    val attachmentActions = rememberPhoneAttachmentActions(
        PhoneAttachmentContext(
            client = client,
            appContext = context,
            scope = scope,
            home = homeState,
            sessions = sessions,
            capabilities = capabilities,
            linkState = linkState,
            openAttachment = openAttachment,
        ),
    )
    val chatAttachSessionState = attachmentActions.chatAttachSession
    val chatAttachSession = chatAttachSessionState.value
    val shareState = attachmentActions.shareState
    val attachSupport = attachmentActions.attachSupport
    val toThread = homeState::toThread
    // The retry/refresh affordances every pulled surface carries. They repeat
    // the arrival pull rather than being a second, quieter kind of ask: what a
    // retry must do is exactly what arriving does.
    val spawnForPlan: (HelmPlanSummary) -> Unit = { plan ->
        planDirPath?.let { dir ->
            homeState.planSpawn = PlanSpawn.of(plan, dir)
            homeState.destination = Destination.Spawn
        }
    }
    // An operator task row's links: the builder's chat, the watched plan's detail.
    val taskLinks = TaskLinks(
        openSession = homeState::openTaskSession,
        openPlan = homeState::openPlanFromTask,
    )
    val refreshPlanBoard: () -> Unit = {
        planDirPath?.let { dir ->
            client.plans.refreshPlans(dir)
            client.plans.refreshSequences(dir)
        }
        Unit
    }
    // Plan/sequence writes (P-0812). Each needs the board's directory so the
    // client can re-pull it on success; with no directory there is no board.
    val createPlan: (String, String, String?, Boolean) -> Unit = { title, description, type, autoImplement ->
        planDirPath?.let { dir -> client.plans.createPlan(dir, title, description, type, autoImplement) }
    }
    val refreshLanes: () -> Unit = {
        planDirPath?.let { dir -> client.plans.refreshSequences(dir) }
        Unit
    }
    val refreshContextNodes: () -> Unit = {
        contextProjectId?.let { id -> client.plans.refreshContexts(id) }
        Unit
    }
    val listedArtifacts = when (val listed = artifactList) {
        is ArtifactList.Ready -> listed.artifacts
        is ArtifactList.Refreshing -> listed.cached
        else -> homeState.selectedSessionId?.let { client.artifacts.state.cachedArtifacts(it) }.orEmpty()
    }

    // The editor's payload, built before composition so no branch has to render
    // a form for an edit it cannot name. A revise whose artifact went missing
    // (list emptied under it, a cold process restore) falls back to the list
    // rather than silently becoming a create.
    val edit: ArtifactEdit? = when {
        homeState.destination != Destination.ArtifactEditor -> null
        homeState.editingArtifactId == null -> ArtifactEdit.New(sessionId = open?.id.orEmpty())
        else -> {
            val revised = listedArtifacts.firstOrNull { it.id == homeState.editingArtifactId }
                ?: (artifactRead as? ArtifactRead.Done)
                    ?.takeIf { it.read.artifact.id == homeState.editingArtifactId }
                    ?.read?.artifact
                ?: (artifactRead as? ArtifactRead.Refreshing)
                    ?.takeIf { it.cached.artifact.id == homeState.editingArtifactId }
                    ?.cached?.artifact
            val shown = homeState.editingShown
            val currentRead = when (val current = artifactRead) {
                is ArtifactRead.Done -> current.read
                is ArtifactRead.Refreshing -> current.cached
                else -> null
            }
            val currentIntent = currentRead
                ?.takeIf { it.artifact.id == homeState.editingArtifactId }
                ?.artifact?.intent ?: revised?.intent ?: com.potatomotato.helm.data.ArtifactIntent.Normal
            if (revised != null && shown != null) ArtifactEdit.Revision(revised, shown, currentIntent) else null
        }
    }
    HelmHomeEffects(
        client = client,
        appContext = context,
        state = HelmHomeEffectState(
            home = homeState,
            pulls = pulls,
            artifactPulls = artifactPulls,
            linkState = linkState,
            capabilities = capabilities,
            clis = clis,
            directories = directories,
            createdSessionId = createdSessionId,
            artifactLanding = artifactLanding,
            artifactSave = artifactSave,
            planWrite = planWriteState,
            artifactFiles = artifactFiles,
            operator = operator,
            liveCall = liveCall,
            projects = projectsState,
            planDirPath = planDirPath,
            contextProjectId = contextProjectId,
            edit = edit,
            shareState = shareState,
            chatAttachSession = chatAttachSessionState,
            dial = dial,
            pickHomeTab = pickHomeTab,
        ),
    )

    Column(modifier = modifier.fillMaxSize()) {
        notice?.let { ActionNoticeBar(notice = it, onDismiss = client.workspace.control::clearNotice) }

        val phoneState = PhoneScaffoldState(
            modifier = Modifier.fillMaxSize(),
            saveableStateHolder = saveableStateHolder,
            homeState = homeState,
            open = open,
            sessions = sessions,
            threads = threads,
            pulls = pulls,
            listedSessions = listedSessions,
            listedSessionIds = listedSessionIds,
            contextHistories = contextHistories,
            linkState = linkState,
            reach = reach,
            unreadCounts = unreadCounts,
            capabilities = capabilities,
            desktops = desktops,
            operator = operator,
            liveCall = liveCall,
            notificationsEnabled = notificationsEnabled,
            snapshot = snapshot,
            requestedLines = requestedLines,
            directories = directories,
            directoriesError = directoriesError,
            clis = clis,
            spawnInFlight = spawnInFlight,
            spawnMachines = spawnMachines,
            projectsState = projectsState,
            project = project,
            planDirPath = planDirPath,
            contextProjectId = contextProjectId,
            planListState = planListState,
            planDetailState = planDetailState,
            planContextsState = planContextsState,
            sequenceListState = sequenceListState,
            sequenceDetailState = sequenceDetailState,
            planWriteState = planWriteState,
            cleanupState = cleanupState,
            contextListState = contextListState,
            contextDetailState = contextDetailState,
            timeState = timeState,
            timeAsk = timeAsk,
            artifactList = artifactList,
            chat = PhoneChatState(
                artifactList = artifactList,
                excludedReferenceIds = excludedComfyReferenceIds,
                cachedArtifactsForSession = client.artifacts.state::cachedArtifacts,
            ),
            artifactRead = artifactRead,
            artifactSave = artifactSave,
            artifactPulls = artifactPulls,
            stagedAttachments = stagedAttachments,
            attachmentErrors = attachmentErrors,
            uploadStates = uploadStates,
            attachSupport = attachSupport,
            listedArtifacts = listedArtifacts,
            edit = edit,
            sessionSwipeOffset = sessionSwipeOffset,
            edgeBounce = edgeBounce,
            chatAttachSession = chatAttachSession,
            shareState = shareState,
        )
        val phoneActions = phoneScaffoldActions(
            PhoneActionContext(
                client = client,
                appContext = context,
                scope = scope,
                homeState = homeState,
                open = open,
                operator = operator,
                liveCall = liveCall,
                dial = dial,
                requestedLines = requestedLines,
                planDirPath = planDirPath,
                planListState = planListState,
                sequenceListState = sequenceListState,
                planWriteState = planWriteState,
                capabilities = capabilities,
                notificationsEnabled = notificationsEnabled,
                artifactRead = artifactRead,
                edit = edit,
                uploadStates = uploadStates,
                listedSessionIds = listedSessionIds,
                pickHomeTab = pickHomeTab,
                taskLinks = taskLinks,
                spawnForPlan = spawnForPlan,
                refreshPlanBoard = refreshPlanBoard,
                createPlan = createPlan,
                refreshLanes = refreshLanes,
                refreshContextNodes = refreshContextNodes,
                toggleLane = toggleLane,
                exportLogs = exportLogs,
                toThread = toThread,
                setTimeAsk = { timeAsk = it },
                openAttachment = openAttachment,
                artifactFiles = artifactFiles,
                comfyGallerySaved = comfyGallerySaved,
                comfyGallerySaveFailed = comfyGallerySaveFailed,
                launchChatAttach = attachmentActions.launchChatAttach,
                openStagedFile = attachmentActions.openStagedFile,
                launchCamera = attachmentActions.launchCamera,
                launchGallery = attachmentActions.launchGallery,
                launchFiles = attachmentActions.launchFiles,
                launchReplace = attachmentActions.launchReplace,
            ),
        )
        BoxWithConstraints(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val layout = LayoutChooser.forWidth(maxWidth.value.toInt())
            val tabletSessions = layout != TabletLayout.Phone &&
                homeState.homeTab == HomeTab.Sessions && homeState.destination == Destination.Thread
            if (tabletSessions) {
                TabletScaffold(phoneState, phoneActions, layout)
            } else {
                PhoneScaffold(phoneState, phoneActions)
            }
            PhoneOverlays(
                state = phoneState,
                actions = phoneActions,
                atRoot = phoneState.open == null && homeState.destination == Destination.Thread,
            )
        }
    }
}

private const val EDGE_BOUNCE_DISTANCE_DP = 10
private const val EDGE_BOUNCE_PULL_MS = 90
private const val EDGE_BOUNCE_DAMPING = 0.62f
private const val EDGE_BOUNCE_STIFFNESS = 720f
