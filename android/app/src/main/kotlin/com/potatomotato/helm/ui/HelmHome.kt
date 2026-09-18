package com.potatomotato.helm.ui

import android.app.Activity
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.HelmApp
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import com.potatomotato.helm.R
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.AttachmentUploadState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.StageVerdict
import com.potatomotato.helm.data.stageVerdict
import com.potatomotato.helm.data.uploadSupport
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.LogExport
import com.potatomotato.helm.log.LogExportResult
import com.potatomotato.helm.notify.PendingOpen
import com.potatomotato.helm.save.AndroidArtifactFiles
import com.potatomotato.helm.save.AndroidAttachmentStaging
import com.potatomotato.helm.save.AndroidLogFiles
import com.potatomotato.helm.ui.artifacts.ArtifactDetailScreen
import com.potatomotato.helm.ui.artifacts.ArtifactEdit
import com.potatomotato.helm.ui.artifacts.ArtifactEditorScreen
import com.potatomotato.helm.ui.artifacts.ArtifactsScreen
import com.potatomotato.helm.ui.chat.ChatScreen
import com.potatomotato.helm.ui.components.ContextMenuItem
import com.potatomotato.helm.ui.components.DialogAction
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.components.glyphRes
import com.potatomotato.helm.ui.components.labelRes
import com.potatomotato.helm.ui.components.LoadNote
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.LoadViews
import com.potatomotato.helm.ui.components.ProjectPicker
import com.potatomotato.helm.ui.components.ScrimDialog
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.components.SessionTabs
import com.potatomotato.helm.ui.components.detailTitle
import com.potatomotato.helm.ui.contexts.ContextDetail
import com.potatomotato.helm.ui.contexts.ContextList
import com.potatomotato.helm.ui.control.ActionNoticeBar
import com.potatomotato.helm.ui.control.SessionSheet
import com.potatomotato.helm.ui.control.SnapshotScreen
import com.potatomotato.helm.ui.control.SpawnScreen
import com.potatomotato.helm.ui.pairing.AwaitingDesktopScreen
import com.potatomotato.helm.ui.pairing.DesktopsScreen
import com.potatomotato.helm.ui.plans.PlanDetail
import com.potatomotato.helm.ui.plans.PlanList
import com.potatomotato.helm.ui.plans.PlanScope
import com.potatomotato.helm.ui.sequences.SequenceDetail
import com.potatomotato.helm.ui.sequences.SequenceList
import com.potatomotato.helm.ui.sessions.SessionListScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Where an open session can take you. One straight path still — the sheet and the
 * screens it opens all hang off [Destination.Thread], never off each other.
 *
 * [Destination.Thread] is not the chat alone: it is the session's TAB surface
 * (chat or artifact list, see [SessionTab]), which is why the artifact detail and
 * editor return to it rather than to a screen of their own.
 */
private enum class Destination {
    Thread,
    Sheet,
    Snapshot,
    Spawn,
    ArtifactDetail,
    ArtifactEditor,
    Desktops,
    Pairing,

    /**
     * The plan, sequence and context detail screens.
     *
     * They sit alongside [Spawn] and [Desktops] rather than under [Thread]
     * because they are reachable WITH NO SESSION OPEN — the root's Plans and
     * Contexts tabs lead here — and reachable again from inside a session's own
     * Plans tab. Which surface opened one is not a distinction they make: the
     * thing on screen is one plan, and back returns to [Thread], which is the
     * root tab or the session tab depending only on whether a session is open.
     */
    PlanDetail,
    SequenceDetail,
    ContextDetail,
}

/**
 * The screens the user lives in, and the navigation between them.
 *
 * Navigation is a nullable session id plus a destination rather than a nav
 * library: the graph is a star around one thread, and a graph definition would be
 * more machinery than the thing it describes. Both are [rememberSaveable] so a
 * rotation does not drop the user back to the list, out of a dictation they are
 * halfway through, or out of a snapshot they are reading.
 */
@Composable
fun HelmHome(client: HelmClient = HelmPairing.client, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val linkState by HelmLink.state.collectAsState()
    val sessions by client.sessions.sessions.collectAsState()
    val reach by client.sessions.reach.collectAsState()
    val threads by client.chats.threads.collectAsState()
    val pulls by client.chats.pulls.collectAsState()
    val unreadCounts by client.chats.unreadCounts.collectAsState()
    val capabilities by client.capabilities.state.collectAsState()
    val snapshot by client.control.snapshot.collectAsState()
    val requestedLines by client.control.requestedLines.collectAsState()
    val notice by client.control.notice.collectAsState()
    val directories by client.control.directories.collectAsState()
    val directoriesError by client.control.directoriesError.collectAsState()
    val clis by client.control.clis.collectAsState()
    val createdSessionId by client.control.createdSessionId.collectAsState()
    val artifactList by client.artifacts.list.collectAsState()
    val artifactRead by client.artifacts.read.collectAsState()
    val artifactSave by client.artifacts.save.collectAsState()
    val artifactLanding by client.control.artifactLanding.collectAsState()
    // The staged files of the artifact create in flight, and where each has got
    // to. Owned by the client, not the editor, for the same reason every
    // transfer on this link is: an upload outruns its screen.
    val stagedAttachments by client.uploads.staged.collectAsState()
    val uploadStates by client.uploads.states.collectAsState()
    val notificationsEnabled by client.alerts.enabled.collectAsState()
    val desktops by HelmPairing.desktops.collectAsState()
    val planListState by client.plans.list.collectAsState()
    val planDetailState by client.plans.detail.collectAsState()
    val planContextsState by client.plans.contextRefs.collectAsState()
    val sequenceListState by client.sequences.list.collectAsState()
    val sequenceDetailState by client.sequences.detail.collectAsState()
    val projectsState by client.contexts.projects.collectAsState()
    val contextListState by client.contexts.list.collectAsState()
    val contextDetailState by client.contexts.detail.collectAsState()
    var openSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    // Deliberately NOT saveable: a rotation must not redraw a question the user
    // never asked, and back is one tap away if they still mean it.
    var leaving by remember { mutableStateOf(false) }
    var where by rememberSaveable { mutableStateOf(Destination.Thread) }
    // Which of the open session's tabs is showing. Saveable for the same reason
    // [where] is: a rotation must not drop a user reading the artifact list back
    // into the conversation.
    var tab by rememberSaveable { mutableStateOf(SessionTab.Chat) }
    var openArtifactId by rememberSaveable { mutableStateOf<String?>(null) }
    // The editor's payload, kept saveable so a rotation or a process death can
    // never turn a half-written revise into a create: the id names the mode
    // (null is create) and the shown body is what a revise starts from. The
    // artifact itself is re-derived from the list, which is re-pulled on arrival.
    var editingArtifactId by rememberSaveable { mutableStateOf<String?>(null) }
    var editingShown by rememberSaveable { mutableStateOf<String?>(null) }
    // Which of the ROOT's surfaces is showing, and the project the two
    // project-scoped ones are about. Saveable for the same reason [tab] is: a
    // rotation must not drop a user reading the plan board back onto the list,
    // nor silently re-point it at a different project than the one they chose.
    var homeTab by rememberSaveable { mutableStateOf(HomeTab.Sessions) }
    var chosenProjectId by rememberSaveable { mutableStateOf<String?>(null) }
    var openPlanId by rememberSaveable { mutableStateOf<String?>(null) }
    // Which sequence lanes the reader has folded shut. SAVED, like every other
    // fact about where the user is: a rotation that silently re-opens eight
    // lanes undoes the tidying that was the point of folding them. Held here
    // rather than in the board so both plan surfaces — the root tab and the
    // in-session one — fold the same lanes, and so the board stays stateless
    // enough to test.
    var collapsedLanes by rememberSaveable(
        stateSaver = listSaver(save = { it.toList() }, restore = { it.toSet() }),
    ) { mutableStateOf(emptySet<String>()) }
    val toggleLane: (String) -> Unit = { laneId ->
        collapsedLanes = if (laneId in collapsedLanes) collapsedLanes - laneId else collapsedLanes + laneId
    }
    var openSequenceId by rememberSaveable { mutableStateOf<String?>(null) }
    var openContextId by rememberSaveable { mutableStateOf<String?>(null) }

    // ONLY while the session list is actually on screen. The poll used to run
    // whenever the app was started, which put a session_list call between every
    // slice of an attachment transfer — two round trips per slice instead of
    // one. Everything else that matters arrives as a push.
    PollSessions(
        client,
        active = openSessionId == null && where == Destination.Thread && homeTab == HomeTab.Sessions,
    )

    // A notification tap lands in that session's THREAD — or, for an artifact
    // row, in its ARTIFACTS. Neither adds a row to the thread: an alert is an
    // event Helm reported, never something an agent said.
    val tapped by PendingOpen.target.collectAsState()
    LaunchedEffect(tapped) {
        PendingOpen.consume()?.let { target ->
            openSessionId = target.sessionId
            tab = if (target.artifacts) SessionTab.Artifacts else SessionTab.Chat
            where = Destination.Thread
        }
    }

    // What the notifier needs to know to stay quiet about the thing on screen —
    // and to clear rows the user has just answered by opening them. The
    // artifacts screens count as reading the session too: opening the list is
    // answering every artifact buzz for it. The same predicate drives the
    // unread badge: a thread on screen is being read, so its count clears on
    // the way in and nothing counts as read once the user leaves it.
    ReportVisibility(client)
    LaunchedEffect(openSessionId, where) {
        val reading = where == Destination.Thread ||
            where == Destination.ArtifactDetail || where == Destination.ArtifactEditor
        client.alerts.opened(openSessionId?.takeIf { reading })
        client.chats.reading(openSessionId?.takeIf { reading })
    }

    val open = sessions.firstOrNull { it.id == openSessionId }
    if (openSessionId != null && open == null && sessions.isNotEmpty()) {
        // The session went away while it was on screen. Fall back to the list
        // rather than leaving the user in a thread that can no longer be replied to.
        openSessionId = null
        where = Destination.Thread
    }

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
    val project = listedProjects.firstOrNull { it.id == chosenProjectId } ?: listedProjects.firstOrNull()
    val planDirPath = PlanScope.resolve(open?.projectPath, project?.canonicalPath)
    val contextProjectId = project?.id

    // The projects are the KEY every other project-scoped ask needs, so they are
    // pulled once, on arriving at a surface that needs them, and never polled.
    // A FAILED ask must be able to come back. Gating only on Idle meant a
    // projects ask attempted before the link was up stayed Failed forever — the
    // effect never re-ran, because nothing in its key had changed. The link
    // state is in the key so a link coming up re-asks, which is how every other
    // pulled surface here already recovers.
    //
    // The KEY is the link, not the failure: keying on "has failed" would re-run
    // the moment the ask failed again and spin. Keying on the link means one
    // retry per link transition, which is exactly one per chance of succeeding.
    LaunchedEffect(homeTab, openSessionId, linkState) {
        val unasked = projectsState is ProjectList.Idle || projectsState is ProjectList.Failed
        if (openSessionId == null && homeTab != HomeTab.Sessions && unasked) client.refreshProjects()
    }

    // The plan, sequence and context surfaces pull ON ARRIVAL, the artifacts
    // way: a fresh ask every visit, never a stream and never a stale cache.
    // Switching tab, switching project or opening a session all re-key this, so
    // each is an arrival.
    LaunchedEffect(where, tab, homeTab, openSessionId, planDirPath, contextProjectId) {
        if (where != Destination.Thread) return@LaunchedEffect
        val inSession = openSessionId != null
        val showingPlans = if (inSession) tab == SessionTab.Plans else homeTab == HomeTab.Plans
        val showingSequences = inSession && tab == SessionTab.Sequences
        val showingContexts = !inSession && homeTab == HomeTab.Contexts
        if (showingPlans && planDirPath != null) {
            // Two asks, because they are two answers: the rows, and the lanes
            // the rows group into. Either may land first. The frontier is not a
            // third ask — the rows carry the edges it is read from.
            client.refreshPlans(planDirPath)
            client.refreshSequences(planDirPath)
        }
        if (showingSequences && planDirPath != null) client.refreshSequences(planDirPath)
        if (showingContexts && contextProjectId != null) client.refreshContexts(contextProjectId)
    }

    // A detail screen pulls the thing it names, whichever surface opened it.
    LaunchedEffect(where, openPlanId) {
        val planId = openPlanId
        if (where == Destination.PlanDetail && planId != null) {
            client.readPlan(planId)
            client.refreshPlanContexts(planId)
        }
    }
    LaunchedEffect(where, openSequenceId) {
        val sequenceId = openSequenceId
        if (where == Destination.SequenceDetail && sequenceId != null) client.readSequence(sequenceId)
    }
    LaunchedEffect(where, openContextId) {
        val contextId = openContextId
        if (where == Destination.ContextDetail && contextId != null) client.readContext(contextId)
    }

    // The permitted surface is asked for when a control surface needs it and is
    // forgotten with the link, so a reconnect re-asks and a capability revoked on
    // the desktop stops being offered. The list needs it too: its New session
    // button greys from the same answer the sheet does — and so do the artifacts
    // screens, whose New/Revise/Save/Delete rows grey from it.
    LaunchedEffect(where, tab, openSessionId, capabilities) {
        val listShowing = openSessionId == null && where != Destination.Spawn
        val artifactsShowing = (where == Destination.Thread && tab == SessionTab.Artifacts) ||
            where == Destination.ArtifactDetail || where == Destination.ArtifactEditor
        if ((where == Destination.Sheet || listShowing || artifactsShowing) && capabilities is Capabilities.Unknown) {
            client.refreshCapabilities()
        }
    }
    LaunchedEffect(where, tab, openSessionId) {
        when {
            where == Destination.Spawn -> {
                if (directories.isEmpty()) client.refreshDirectories()
                if (clis.isEmpty()) client.refreshClis()
            }
            // The artifacts screens pull on arrival, like a snapshot pull: a
            // fresh ask every visit, never a stream and never a stale cache.
            // This is also why the artifact writes need no follow-up ask of
            // their own — returning from one re-pulls what it changed. Switching
            // TO the tab is an arrival; switching away and back pulls again.
            where == Destination.Thread && tab == SessionTab.Artifacts ->
                openSessionId?.let { client.refreshArtifacts(it) }
            where == Destination.ArtifactDetail ->
                if (openSessionId != null && openArtifactId != null) {
                    client.readArtifact(openSessionId!!, openArtifactId!!, version = null)
                }
            else -> {}
        }
    }

    // A spawn Helm confirmed names the session it made, and that id is how the
    // new thread opens. The opening WAITS until the row is actually in the
    // list: jumping straight there would trip the went-away fallback above (the
    // next 2s poll has not shown the session yet) and dump the user back on the
    // list. A session that never appears gives up quietly — the notice bar has
    // already said the spawn succeeded, and the list is one poll away.
    LaunchedEffect(createdSessionId) {
        val id = createdSessionId ?: return@LaunchedEffect
        var polls = 0
        // No refreshSessions() here on purpose: PollSessions below is already
        // polling every 2s while this screen is visible; a second caller would
        // just double the wire traffic for the same list.
        while (client.sessions.sessions.value.none { it.id == id } && polls < CREATED_SESSION_POLLS) {
            delay(POLL_INTERVAL_MS)
            polls++
        }
        client.control.clearCreatedSession(id)
        if (client.sessions.sessions.value.any { it.id == id }) {
            openSessionId = id
            // A newly-created session is an opening just like tapping a list
            // row; never inherit the previous session's artifact tab/detail.
            tab = SessionTab.Chat
            openArtifactId = null
            editingArtifactId = null
            editingShown = null
            where = Destination.Thread
        }
    }

    // An artifact write that LANDED moves the user once. Create opens the new
    // artifact's detail; revise returns to the detail it came from (which
    // re-pulls the fresh body on arrival); delete returns to the list (which
    // re-pulls without the row). Consumed exactly once, so two identical
    // outcomes both navigate and a rotation does not drag anyone anywhere.
    LaunchedEffect(artifactLanding) {
        val landing = artifactLanding ?: return@LaunchedEffect
        client.control.consumeArtifactLanding()
        when (landing.action) {
            SessionAction.CreateArtifact -> {
                val id = landing.artifactId
                if (id == null) {
                    // The answer named no artifact; the list is where the new
                    // row is one pull away.
                    where = Destination.Thread
                } else {
                    openArtifactId = id
                    editingArtifactId = null
                    editingShown = null
                    where = Destination.ArtifactDetail
                }
                // The landing that arrives here AFTER a staged create is the
                // chain's own "everything is attached" moment (the client
                // defers it until then) — so this is where the chips retire.
                // Waiting chips of a plain create go with them: they described
                // one create, which is over.
                client.uploads.clear()
            }
            SessionAction.ReviseArtifact -> {
                editingArtifactId = null
                editingShown = null
                where = Destination.ArtifactDetail
            }
            SessionAction.DeleteArtifact -> where = Destination.Thread
            else -> {}
        }
    }

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
                client.control.noticed(
                    SessionAction.SaveArtifact,
                    ActionOutcome.Failed(context.getString(R.string.chat_attachment_no_viewer)),
                )
            }
        }
    }

    val artifactFiles = remember { AndroidArtifactFiles(context) }

    LaunchedEffect(artifactSave) {
        val ready = artifactSave as? ArtifactSave.Ready ?: return@LaunchedEffect
        try {
            val path = withContext(Dispatchers.IO) {
                artifactFiles.save(ready.file.filename, ready.file.mimeType, ready.file.bytes)
            }
            client.artifacts.saveLanded(ready.file.artifactId, path.location)
            client.control.noticed(SessionAction.SaveArtifact, ActionOutcome.Done)
        } catch (error: Exception) {
            client.artifacts.saveFailed(
                ready.file.artifactId,
                error.message ?: CANNOT_WRITE_FILE,
            )
        }
    }

    // The log export deliberately does NOT go over the link: the reports it
    // exists to serve are "it says Linked but nothing arrives", so an export
    // that needed the desktop would be broken in exactly the case it is for.
    // Strings are resolved here rather than in the callback — stringResource
    // reads the composition, which a click handler is no longer inside.
    val logFiles = remember { AndroidLogFiles(context) }
    val scope = rememberCoroutineScope()
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

    // The artifact editor's attach half: pickers at the UI edge, staging through
    // the client's port, chips driven by the client's own upload state.
    val staging = remember { AndroidAttachmentStaging(context) }
    var cameraTarget by remember { mutableStateOf<Uri?>(null) }
    val attachNote: (Int) -> Unit = { res ->
        Toast.makeText(context, context.getString(res), Toast.LENGTH_LONG).show()
    }
    // A pick becomes a chip only if it can be READ (here, now — a revoked grant
    // must not become a chip that fails later) and is within the size the
    // desktop would accept. Both refusals are toasts: they are about one tap,
    // not about the editor.
    val stagePick: (Uri) -> Unit = { uri ->
        scope.launch {
            val picked = staging.stage(uri.toString(), displayName = null, mimeType = null)
            when {
                picked == null -> attachNote(R.string.artifacts_attach_refused)
                stageVerdict(picked.sizeBytes) is StageVerdict.TooLarge -> {
                    staging.discard(picked)
                    attachNote(R.string.artifacts_attach_too_large)
                }
                else -> client.uploads.stage(picked)
            }
        }
        Unit
    }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val target = cameraTarget
        cameraTarget = null
        if (captured && target != null) stagePick(target)
    }
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) stagePick(uri)
    }
    val filesLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) stagePick(uri)
    }
    // The chip tap opens the LOCAL copy through the provider — the picker's own
    // uri may be long dead by the time the user taps.
    val openStagedFile: (StagedAttachment) -> Unit = { staged ->
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", File(staged.localPath))
        openAttachment(uri.toString(), staged.mimeType ?: DEFAULT_OPEN_MIME)
    }
    // The greying verdict for the toolbar: both gates — the negotiated protocol
    // AND the desktop's permitted-tools answer — read live, so revoking either
    // side turns the circles off the moment this screen recomposes.
    val attachSupport = uploadSupport(
        toolPermitted = when (val caps = capabilities) {
            is Capabilities.Known -> METHOD_ATTACHMENT_ADD in caps.tools
            else -> null
        },
        negotiatedProtocol = client.negotiatedProtocol(),
        linked = linkState == LinkState.Linked,
    )

    val toThread = { where = Destination.Thread }
    // The retry/refresh affordances every pulled surface carries. They repeat
    // the arrival pull rather than being a second, quieter kind of ask: what a
    // retry must do is exactly what arriving does.
    val refreshPlanBoard: () -> Unit = {
        planDirPath?.let { dir ->
            client.refreshPlans(dir)
            client.refreshSequences(dir)
        }
        Unit
    }
    val refreshLanes: () -> Unit = {
        planDirPath?.let { dir -> client.refreshSequences(dir) }
        Unit
    }
    val refreshContextNodes: () -> Unit = {
        contextProjectId?.let { id -> client.refreshContexts(id) }
        Unit
    }
    val listedArtifacts = when (val listed = artifactList) {
        is ArtifactList.Ready -> listed.artifacts
        is ArtifactList.Refreshing -> listed.cached
        else -> openSessionId?.let { client.artifacts.cachedArtifacts(it) }.orEmpty()
    }
    // Snapshot has two entry points (overflow and the composer shortcut), but
    // one transition and one initial pull. Keeping that contract here prevents
    // the convenient button drifting from the established context-menu action.
    val openTerminalPreview = {
        where = Destination.Snapshot
        client.readTerminal(open?.id.orEmpty(), requestedLines)
        Unit
    }

    // The editor's payload, built before composition so no branch has to render
    // a form for an edit it cannot name. A revise whose artifact went missing
    // (list emptied under it, a cold process restore) falls back to the list
    // rather than silently becoming a create.
    val edit: ArtifactEdit? = when {
        where != Destination.ArtifactEditor -> null
        editingArtifactId == null -> ArtifactEdit.New(sessionId = open?.id.orEmpty())
        else -> {
            val revised = listedArtifacts.firstOrNull { it.id == editingArtifactId }
                ?: (artifactRead as? ArtifactRead.Done)
                    ?.takeIf { it.read.artifact.id == editingArtifactId }
                    ?.read?.artifact
                ?: (artifactRead as? ArtifactRead.Refreshing)
                    ?.takeIf { it.cached.artifact.id == editingArtifactId }
                    ?.cached?.artifact
            val shown = editingShown
            if (revised != null && shown != null) ArtifactEdit.Revision(revised, shown) else null
        }
    }
    LaunchedEffect(where, edit) {
        if (where == Destination.ArtifactEditor && edit == null) where = Destination.Thread
    }

    Column(modifier = modifier.fillMaxSize()) {
        notice?.let { ActionNoticeBar(notice = it, onDismiss = client.control::clearNotice) }

        Box(modifier = Modifier.fillMaxSize()) {
            when {
                // Spawn is reachable with NO session open — the list's New
                // session button lands here — so it goes first: it touches no
                // session, and putting it above the null check is what lets the
                // branches below keep their non-null smart cast.
                // Same reasoning as Spawn: reachable with no session open, so
                // it sits above the null check rather than inside it.
                where == Destination.Desktops -> {
                    BackHandler(onBack = toThread)
                    DesktopsScreen(
                        desktops = desktops,
                        linkState = linkState,
                        onRename = HelmPairing::rename,
                        onForget = HelmPairing::forget,
                        onBack = toThread,
                    )
                }

                // Reachable with no session open, same as Spawn and Desktops.
                // A desktop connecting mid-wait is not handled here at all: it
                // drives PairingController into Handshaking/Comparing, and
                // HelmRoot's own `when` renders that interstitial ABOVE this
                // composition regardless of `where` — so this branch just stops
                // being drawn rather than needing to navigate itself away.
                where == Destination.Pairing -> {
                    BackHandler(onBack = toThread)
                    AwaitingDesktopScreen(
                        linkState = linkState,
                        onReadvertise = { HelmLinkService.forcePairingMode(context) },
                        onBack = toThread,
                    )
                }

                where == Destination.Spawn -> {
                    BackHandler(onBack = toThread)
                    SpawnScreen(
                        directories = directories,
                        clis = clis,
                        directoriesError = directoriesError,
                        sessions = sessions,
                        linkState = linkState,
                        onSpawn = { dirPath, cliType, name ->
                            // Navigation is decided by the OUTCOME, not by the
                            // tap: success arrives as createdSessionId above,
                            // failure as the notice bar's to say — so the form
                            // keeps its choices instead of leaving on faith.
                            client.spawn(dirPath, cliType, name)
                        },
                        onRetryDirectories = { client.refreshDirectories() },
                        onBack = toThread,
                    )
                }

                // The three detail screens sit here, above the null check, for
                // the same reason Spawn does: they are reachable with no session
                // open (the root's Plans and Contexts tabs lead to them), and
                // they need no session to render. Back goes to Thread, which is
                // the root tab row or the session's, whichever the user was on.
                // Each one wears the app bar every other full-screen destination
                // wears. The link badge matters MOST here: these are the screens
                // that sit waiting on an answer from the desktop, so a dropped
                // link has to be readable without leaving them.
                where == Destination.PlanDetail -> {
                    BackHandler(onBack = toThread)
                    val plan = LoadViews.plan(planDetailState, openPlanId)
                    Column(modifier = Modifier.fillMaxSize()) {
                        HelmAppBar(
                            title = detailTitle(plan, stringResource(R.string.plan_detail_title)) { it.title },
                            linkState = linkState,
                            onBack = toThread,
                        )
                        PlanDetail(
                            plan = plan,
                            contexts = LoadViews.planContexts(planContextsState, openPlanId),
                            onRefresh = {
                                openPlanId?.let { planId ->
                                    client.readPlan(planId)
                                    client.refreshPlanContexts(planId)
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                where == Destination.SequenceDetail -> {
                    BackHandler(onBack = toThread)
                    val sequence = LoadViews.sequence(sequenceDetailState, openSequenceId)
                    Column(modifier = Modifier.fillMaxSize()) {
                        HelmAppBar(
                            title = detailTitle(sequence, stringResource(R.string.sequence_detail_title)) { it.title },
                            linkState = linkState,
                            onBack = toThread,
                        )
                        SequenceDetail(
                            sequence = sequence,
                            onRefresh = { openSequenceId?.let { client.readSequence(it) } },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                where == Destination.ContextDetail -> {
                    BackHandler(onBack = toThread)
                    val contextNode = LoadViews.context(contextDetailState, openContextId)
                    Column(modifier = Modifier.fillMaxSize()) {
                        HelmAppBar(
                            title = detailTitle(contextNode, stringResource(R.string.context_detail_title)) { it.title },
                            linkState = linkState,
                            onBack = toThread,
                        )
                        ContextDetail(
                            context = contextNode,
                            onRefresh = { openContextId?.let { client.readContext(it) } },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                // The ROOT — one bar whose context label is the surface menu,
                // and whichever of the three surfaces it selects. Back off a
                // non-Sessions surface returns to Sessions rather than offering
                // to quit; the root BackHandler further down is gated on the
                // Sessions surface for exactly that reason.
                open == null -> Column(modifier = Modifier.fillMaxSize()) {
                    BackHandler(enabled = homeTab != HomeTab.Sessions) { homeTab = HomeTab.Sessions }
                    HelmAppBar(
                        title = stringResource(R.string.app_name),
                        linkState = linkState,
                        contextLabel = stringResource(homeTab.labelRes),
                        contextMenuItems = HomeTab.entries.map {
                            ContextMenuItem(stringResource(it.labelRes), it.glyphRes)
                        },
                        onSelectContextItem = { homeTab = HomeTab.entries[it] },
                        onLinkClick = { where = Destination.Desktops },
                        onExportLogs = exportLogs,
                        notificationsEnabled = notificationsEnabled,
                        onToggleNotifications = { client.alerts.setEnabled(!notificationsEnabled) },
                    )
                    Box(modifier = Modifier.weight(1f)) {
                        when (homeTab) {
                            HomeTab.Sessions -> SessionListScreen(
                                sessions = sessions,
                                linkState = linkState,
                                reach = reach,
                                capabilities = capabilities,
                                unread = unreadCounts,
                                onOpen = { session ->
                                    openSessionId = session.id
                                    tab = SessionTab.Chat
                                },
                                onLongPress = { session ->
                                    openSessionId = session.id
                                    tab = SessionTab.Chat
                                    where = Destination.Sheet
                                },
                                onNewSession = {
                                    openSessionId = null
                                    where = Destination.Spawn
                                },
                                onPairDesktop = {
                                    HelmLinkService.forcePairingMode(context)
                                    where = Destination.Pairing
                                },
                            )

                            HomeTab.Plans -> ProjectScoped(
                                projects = LoadViews.projects(projectsState),
                                project = project,
                                onSelectProject = { chosenProjectId = it.id },
                                onRetryProjects = { client.refreshProjects() },
                                noProjectText = stringResource(R.string.plans_no_project),
                            ) {
                                PlanList(
                                    plans = LoadViews.plans(planListState, planDirPath),
                                    sequences = LoadViews.sequences(sequenceListState, planDirPath),
                                    collapsedLaneIds = collapsedLanes,
                                    onToggleLane = toggleLane,
                                    onOpen = { plan ->
                                        openPlanId = plan.id
                                        where = Destination.PlanDetail
                                    },
                                    onRefresh = refreshPlanBoard,
                                )
                            }

                            HomeTab.Contexts -> ProjectScoped(
                                projects = LoadViews.projects(projectsState),
                                project = project,
                                onSelectProject = { chosenProjectId = it.id },
                                onRetryProjects = { client.refreshProjects() },
                                noProjectText = stringResource(R.string.contexts_no_project),
                            ) {
                                ContextList(
                                    contexts = LoadViews.contexts(contextListState, contextProjectId),
                                    onOpen = { node ->
                                        openContextId = node.id
                                        where = Destination.ContextDetail
                                    },
                                    onRefresh = refreshContextNodes,
                                )
                            }
                        }
                    }
                }

                where == Destination.Snapshot -> {
                    BackHandler(onBack = toThread)
                    SnapshotScreen(
                        snapshot = snapshot,
                        requestedLines = requestedLines,
                        linkState = linkState,
                        onPull = { lines -> client.readTerminal(open.id, lines) },
                        onBack = toThread,
                    )
                }

                where == Destination.ArtifactEditor && edit != null -> {
                    val leaveEditor = {
                        // Leaving retires the stage ONLY while nothing is being
                        // sent: mid-upload the chips are the only surface that
                        // shows a failure, and the chain itself must finish —
                        // the landing that closes the editor arrives later.
                        if (uploadStates.values.none { it is AttachmentUploadState.Uploading }) {
                            client.uploads.clear()
                        }
                        where = if (editingArtifactId == null) {
                            Destination.Thread
                        } else {
                            Destination.ArtifactDetail
                        }
                        Unit
                    }
                    BackHandler(
                        // Back undoes the edit without a wire call: a create
                        // returns to the list it came from, a revise to the
                        // artifact it was revising.
                        onBack = leaveEditor,
                    )
                    ArtifactEditorScreen(
                        edit = edit,
                        linkState = linkState,
                        staged = stagedAttachments,
                        uploadStates = uploadStates,
                        attachSupport = attachSupport,
                        onAttachCamera = {
                            val dir = File(context.cacheDir, CAMERA_DIRECTORY).apply { mkdirs() }
                            val file = File(dir, "capture-${System.nanoTime()}.jpg")
                            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                            cameraTarget = uri
                            cameraLauncher.launch(uri)
                        },
                        onAttachGallery = {
                            galleryLauncher.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                            )
                        },
                        onAttachFiles = { filesLauncher.launch(ANY_MIME) },
                        onOpenStaged = openStagedFile,
                        onRemoveStaged = client.uploads::unstage,
                        onRetryStaged = { client.retryArtifactUploads() },
                        onSubmit = { title, content ->
                            if (edit is ArtifactEdit.New) {
                                // The staged keys ride the create; the client
                                // chains the uploads and lands the notice only
                                // when the last commit has answered.
                                client.createArtifact(open.id, title, content, client.uploads.pendingKeys())
                            } else {
                                val artifactId = editingArtifactId
                                if (artifactId != null) client.reviseArtifact(open.id, artifactId, content)
                            }
                        },
                        onBack = leaveEditor,
                    )
                }

                // The editor's payload went missing under it — the reset effect
                // is one frame away from landing on the list. Nothing renders
                // here, and nothing may: rendering the thread would flash a
                // conversation into a screen the user left.
                where == Destination.ArtifactEditor -> Unit

                where == Destination.ArtifactDetail -> {
                    BackHandler(onBack = toThread)
                    ArtifactDetailScreen(
                        // The row the list showed names the artifact while its
                        // body is still crossing the link; the read state takes
                        // over once it lands.
                        artifact = listedArtifacts.firstOrNull { it.id == openArtifactId },
                        state = artifactRead,
                        saveState = artifactSave,
                        capabilities = capabilities,
                        linkState = linkState,
                        onPull = { version ->
                            openSessionId?.let { session -> client.readArtifact(session, openArtifactId!!, version) }
                        },
                        onRevise = {
                            editingArtifactId = openArtifactId
                            editingShown = when (val current = artifactRead) {
                                is ArtifactRead.Done -> current.read.content
                                is ArtifactRead.Refreshing -> current.cached.content
                                else -> null
                            }
                            where = Destination.ArtifactEditor
                        },
                        onDownload = {
                            openSessionId?.let { session ->
                                client.downloadArtifact(session, openArtifactId!!, version = null)
                            }
                        },
                        onDownloadAttachment = { attachment ->
                            openSessionId?.let { session ->
                                client.downloadArtifactAttachment(session, openArtifactId!!, attachment.id)
                            }
                        },
                        onDelete = {
                            openSessionId?.let { session ->
                                client.deleteArtifact(session, openArtifactId!!)
                            }
                        },
                        onBack = toThread,
                    )
                }

                // The session's tab surface — and what the sheet's scrim sits
                // over, which is why Sheet lands here too rather than on a blank
                // screen: the actions must name the session they belong to.
                else -> {
                    val toList = { openSessionId = null }
                    BackHandler(onBack = toList)
                    SessionTabScaffold(
                        sessionName = open.name,
                        linkState = linkState,
                        tab = tab,
                        onSelectTab = { tab = it },
                        onBack = toList,
                        onOverflow = { where = Destination.Sheet },
                    ) {
                        when (tab) {
                            SessionTab.Chat -> ChatScreen(
                                sessionId = open.id,
                                messages = threads[open.id].orEmpty(),
                                onSend = { text -> client.sendChat(open.id, text) },
                                // Retry re-issues over the wire (the repository
                                // swaps the dead row); delete is a purely local
                                // take-back, so it goes straight to the store.
                                onRetry = { key, text -> client.resendChat(open.id, key, text) },
                                onDelete = { key -> client.chats.remove(open.id, key) },
                                onTerminal = openTerminalPreview,
                                pulls = pulls,
                                onPull = { key, attachment ->
                                    client.pullChatAttachment(open.id, key, attachment)
                                },
                                onCancelPull = { key -> client.chats.pullCancelled(key) },
                                onDeleteAttachment = { key, attachment ->
                                    client.deleteChatAttachment(open.id, key, attachment)
                                },
                                onOpenAttachment = openAttachment,
                            )

                            SessionTab.Artifacts -> ArtifactsScreen(
                                state = artifactList,
                                capabilities = capabilities,
                                onOpen = { artifact ->
                                    openArtifactId = artifact.id
                                    where = Destination.ArtifactDetail
                                },
                                onNew = {
                                    editingArtifactId = null
                                    editingShown = null
                                    where = Destination.ArtifactEditor
                                },
                            )

                            // The SAME composables the root's Plans tab renders,
                            // pointed at this session's working directory
                            // instead of a chosen project. No picker: the
                            // session already answered which scope this is.
                            // A session spawned without a working directory has
                            // no plans to ask for, and the root's project picker
                            // cannot stand in for one — an open session is the
                            // scope. Say so, rather than leave a spinner that
                            // nothing will ever answer. The tabs STAY: a tab
                            // that vanishes for some sessions is a worse
                            // explanation than a sentence.
                            SessionTab.Plans -> if (planDirPath == null) {
                                LoadNote(stringResource(R.string.plans_no_session_directory))
                            } else {
                                PlanList(
                                    plans = LoadViews.plans(planListState, planDirPath),
                                    sequences = LoadViews.sequences(sequenceListState, planDirPath),
                                    collapsedLaneIds = collapsedLanes,
                                    onToggleLane = toggleLane,
                                    onOpen = { plan ->
                                        openPlanId = plan.id
                                        where = Destination.PlanDetail
                                    },
                                    onRefresh = refreshPlanBoard,
                                )
                            }

                            SessionTab.Sequences -> if (planDirPath == null) {
                                LoadNote(stringResource(R.string.sequences_no_session_directory))
                            } else {
                                SequenceList(
                                    sequences = LoadViews.sequences(sequenceListState, planDirPath),
                                    onOpen = { sequence ->
                                        openSequenceId = sequence.id
                                        where = Destination.SequenceDetail
                                    },
                                    onRefresh = refreshLanes,
                                )
                            }
                        }
                    }
                }
            }

            // The sheet is an overlay on the thread, not a screen of its own: the
            // conversation stays visible behind the scrim, which is what tells the
            // user which session these actions belong to.
            if (open != null && where == Destination.Sheet) {
                BackHandler(onBack = toThread)
                SessionSheet(
                    sessionName = open.name,
                    capabilities = capabilities,
                    onDismiss = toThread,
                    onAction = { action ->
                        where = when (action) {
                            SessionAction.Snapshot -> Destination.Snapshot
                            SessionAction.Spawn -> Destination.Spawn
                            SessionAction.Compact -> Destination.Thread.also { client.compact(open.id) }
                            SessionAction.Close -> Destination.Thread.also { client.closeSession(open.id) }
                            // Rename never reaches here — it is answered by
                            // onRename below, because it carries a name. The
                            // artifact actions never reach here either: their
                            // rows live on the artifacts tab and the screens
                            // under it, where the thing acted on is visible.
                            SessionAction.Rename -> Destination.Thread
                            else -> Destination.Thread
                        }
                        // A snapshot is pulled as soon as it is asked for, at the
                        // count the chip row already shows (the smallest one before
                        // the first choice): arriving on an empty terminal screen
                        // and having to choose again is a step nobody wants.
                        if (action == SessionAction.Snapshot) client.readTerminal(open.id, requestedLines)
                    },
                    // Back to the thread rather than staying on the sheet: the
                    // notice bar says how it ended and the app bar shows the new
                    // name, which is the same landing every other action gets.
                    onRename = { name ->
                        client.renameSession(open.id, name)
                        where = Destination.Thread
                    },
                )
            }

            // Back at the true root — the session list, nothing open over it.
            //
            // GATED, NOT MERELY LAST: this composes AFTER the branch handlers
            // above, and the dispatcher gives back to the most recently added
            // enabled callback. Without the condition it would swallow every
            // in-app back and offer to quit from halfway down the app.
            //
            // WHY ASK AT ALL: backgrounding keeps the foreground service, and
            // with it the BLE link and the notifications, alive. Quitting drops
            // them. A stray back used to take the destructive option silently.
            // The Plans and Contexts tabs are NOT the root: back off one of them
            // returns to Sessions (handled in that branch), and offering to quit
            // from there would be the same silent destructive answer this
            // dialog exists to stop.
            val atRoot = openSessionId == null &&
                where == Destination.Thread &&
                homeTab == HomeTab.Sessions
            BackHandler(enabled = atRoot) { leaving = !leaving }
            // A notification tap can navigate out from under an open dialog.
            // Drop the question with the screen it was asked on, so returning
            // to the list later does not find it still waiting.
            LaunchedEffect(atRoot) { if (!atRoot) leaving = false }
            if (leaving && atRoot) {
                ExitDialog(
                    onBackground = {
                        leaving = false
                        // moveTaskToBack, never finish(): the task stays in
                        // Recents exactly where the user left it, and the
                        // service keeps the link up behind it.
                        (context as? Activity)?.moveTaskToBack(true)
                    },
                    onQuit = {
                        leaving = false
                        // Quit means QUIT. The foreground service outlives the
                        // activity by design when backgrounding, so finishing
                        // alone leaves the link and its notification running —
                        // observed as "quit doesn't work" with Helm still
                        // online on the desktop afterwards. LAN is the same
                        // story but sneakier: it lives in HelmPairing, not the
                        // service, and its non-daemon pump thread keeps the
                        // whole process — and the socket — alive after finish().
                        HelmPairing.stopLan()
                        HelmLinkService.stop(context)
                        (context as? Activity)?.finish()
                    },
                    onDismiss = { leaving = false },
                )
            }
        }
    }
}

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
private fun ProjectScoped(
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

/** The one question back asks at the root. See the BackHandler above for why. */
@Composable
private fun ExitDialog(onBackground: () -> Unit, onQuit: () -> Unit, onDismiss: () -> Unit) {
    ScrimDialog(
        title = stringResource(R.string.exit_title),
        body = stringResource(R.string.exit_body),
        onDismiss = onDismiss,
    ) {
        // Backgrounding leads because it is both the safe answer and the one
        // the user almost always meant by pressing back.
        DialogAction(text = stringResource(R.string.exit_background), onClick = onBackground)
        DialogAction(text = stringResource(R.string.exit_quit), onClick = onQuit, emphasised = false)
        DialogAction(text = stringResource(R.string.exit_cancel), onClick = onDismiss, emphasised = false)
    }
}

/**
 * The chrome an open session wears, whichever tab is showing.
 *
 * One owner for the bar and the tab row means switching tabs re-lays-out only the
 * body: the title, the link badge and the ⋮ do not blink, and neither can drift
 * apart between the two tabs.
 */
@Composable
private fun SessionTabScaffold(
    sessionName: String,
    linkState: LinkState,
    tab: SessionTab,
    onSelectTab: (SessionTab) -> Unit,
    onBack: () -> Unit,
    onOverflow: () -> Unit,
    body: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        HelmAppBar(title = sessionName, linkState = linkState, onBack = onBack, onOverflow = onOverflow)
        SessionTabs(selected = tab, onSelect = onSelectTab)
        Box(modifier = Modifier.weight(1f)) { body() }
    }
}

/**
 * Keep the list fresh while the user can see it — and ONLY while they can.
 *
 * TWO conditions, and the second was learned the hard way. The lifecycle scope
 * (STARTED) keeps a phone in a pocket from spending the desktop's per-device
 * budget, which was sized for a visible screen. [active] adds the screen
 * itself: the poll used to run behind every other screen too, so a
 * `session_list` landed between every slice of an attachment transfer — two
 * round trips per slice instead of one, on a link where a round trip is most of
 * the cost. Nothing else needs it; alerts and chat arrive as pushes.
 *
 * The trade, stated because it is real: an OPEN session's row data stops
 * refreshing while the user is inside it.
 *
 * Keyed on [active], so returning to the list polls immediately rather than
 * waiting out an interval.
 */
@Composable
private fun PollSessions(client: HelmClient, active: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(lifecycle, active) {
        if (!active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                client.refreshSessions()
                delay(POLL_INTERVAL_MS)
            }
        }
    }
}

/**
 * Tell the notifier whether the user can actually see the app.
 *
 * STARTED and not RESUMED is the right line: an app visible behind the pairing
 * dialog is still being looked at, while one in the recents carousel is not.
 * Without this the phone would go silent for a session left open in a pocket —
 * which is precisely the case the whole feature exists for.
 */
@Composable
private fun ReportVisibility(client: HelmClient) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            client.alerts.visible(true)
            try {
                awaitCancellation()
            } finally {
                client.alerts.visible(false)
            }
        }
    }
}

/** Half the per-device budget, leaving room for whatever the user is doing. */
private const val POLL_INTERVAL_MS = 2_000L

/**
 * How long a confirmed spawn waits for its session to show in the list before
 * giving up on opening the thread. The desktop records the session before it
 * answers, so one poll is normally enough — this is the rope, not the path.
 */
private const val CREATED_SESSION_POLLS = 10

/** The sink threw with no message of its own; the row still needs a reason. */
private const val CANNOT_WRITE_FILE = "The phone could not write the file"

/** Where camera captures wait to become staged attachments (a FileProvider path). */
private const val CAMERA_DIRECTORY = "artifact-capture"

/** The pickers' ask: anything the user can name, the desktop's size gate judges. */
private const val ANY_MIME = "*/*"

/** A staged file that never said what it is still opens as SOMETHING. */
private const val DEFAULT_OPEN_MIME = "application/octet-stream"

/** The upload slot-open tool — the one the toolbar's greying must see granted. */
private const val METHOD_ATTACHMENT_ADD = "session_artifact_attachment_add"
