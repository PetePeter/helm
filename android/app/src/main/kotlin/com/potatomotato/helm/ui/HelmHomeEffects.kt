package com.potatomotato.helm.ui

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.potatomotato.helm.R
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactLanding
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.HelmDirectory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.PlanWriteKind
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.ShareState
import com.potatomotato.helm.notify.PendingOpen
import com.potatomotato.helm.save.AndroidArtifactFiles
import com.potatomotato.helm.ui.artifacts.ArtifactEdit
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.operator.OperatorKey
import com.potatomotato.helm.ui.operator.OperatorKeyAction
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.operator.OperatorSummary
import com.potatomotato.helm.voice.PttKey
import com.potatomotato.helm.voice.VoiceCallService
import android.content.Context
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal data class HelmHomeEffectState(
    val home: HelmHomeState,
    val pulls: Map<String, PullState>,
    val artifactPulls: Map<String, PullState>,
    val linkState: LinkState,
    val capabilities: Capabilities,
    val clis: List<HelmCli>,
    val directories: List<HelmDirectory>,
    val createdSessionId: String?,
    val artifactLanding: ArtifactLanding?,
    val artifactSave: ArtifactSave,
    val planWrite: PlanWrite,
    val artifactFiles: AndroidArtifactFiles,
    val operator: OperatorSummary,
    val liveCall: VoiceCallService.Call?,
    val projects: ProjectList,
    val planDirPath: String?,
    val contextProjectId: String?,
    val edit: ArtifactEdit?,
    val shareState: ShareState,
    val chatAttachSession: MutableState<HelmSession?>,
    val dial: (String) -> Unit,
    val pickHomeTab: (HomeTab) -> Unit,
)

/** Client and navigation effects stay together; renderers only receive their state and callbacks. */
@Composable
internal fun HelmHomeEffects(client: HelmClient, appContext: Context, state: HelmHomeEffectState) {
    val home = state.home
    val callScreenTarget = home.selectedSessionId
        ?: (state.operator as? OperatorSummary.On)?.id?.takeIf {
            home.destination == Destination.Thread && home.homeTab == HomeTab.Helm
        }

    // Only while sessions are actually on screen: the list, or an open session
    // whose app bar follows the desktop. Never mid-transfer: a session_list
    // between attachment slices made every slice two round trips instead of one.
    val onList = home.selectedSessionId == null && home.destination == Destination.Thread && home.homeTab == HomeTab.Sessions
    val transferring = (state.pulls.values + state.artifactPulls.values).any { it is PullState.Pulling }
    WatchSessions(
        client,
        active = onList || (home.selectedSessionId != null && home.destination == Destination.Thread && !transferring),
    )

    // A notification tap lands in that session's THREAD — or, for an artifact
    // row, in its ARTIFACTS. Neither adds a row to the thread: an alert is an
    // event Helm reported, never something an agent said.
    val tapped by PendingOpen.target.collectAsState()
    LaunchedEffect(tapped) {
        PendingOpen.consume()?.let { target -> home.openNotification(target.sessionId, target.artifacts) }
    }

    // Keep chat unread state aligned with the session content on screen. The
    // artifact screens count as reading the session too. The Helm home tab also
    // shows the operator's thread without opening it.
    // The lastCallTarget effect follows call-driven transfers. Don't sync on call-target
    // updates or a stale chat would transfer the call back.
    LaunchedEffect(state.liveCall != null, callScreenTarget) {
        val call = state.liveCall ?: return@LaunchedEffect
        val target = callScreenTarget ?: return@LaunchedEffect
        if (call.targetId != target) VoiceCallService.retarget(appContext, target)
    }

    // The "Call operator" shortcut (a hardware key can launch it). On a cold start
    // the operator is not listed until the link is up, so a press stays parked
    // until it is — consumed only when acted on, because the first compositions
    // of a cold start are torn down and would take a consumed press with them.
    val keyPress by OperatorKey.pending.collectAsState()
    val operatorId = (state.operator as? OperatorSummary.On)?.id
    LaunchedEffect(keyPress, operatorId, state.liveCall?.targetId) {
        if (!keyPress) return@LaunchedEffect
        val liveTarget = state.liveCall?.targetId
        if (operatorId == null && liveTarget == null) return@LaunchedEffect
        if (!OperatorKey.consume()) return@LaunchedEffect
        when (val action = OperatorKeyAction.decide(operatorId, liveTarget, home.selectedSessionId)) {
            is OperatorKeyAction.Dial -> {
                if (action.targetId != home.selectedSessionId) {
                    // The operator's chat is the Helm tab, so this shortcut keeps the call there.
                    home.selectedSessionId = null
                    home.destination = Destination.Thread
                    if (home.homeTab != HomeTab.Helm) state.pickHomeTab(HomeTab.Helm)
                }
                state.dial(action.targetId)
            }
            OperatorKeyAction.HangUp -> VoiceCallService.hangUp(appContext)
            OperatorKeyAction.Unavailable -> Unit
        }
    }
    // Bounded: a press the operator never turns up for is dropped, never dialled late.
    LaunchedEffect(keyPress) {
        if (!keyPress) return@LaunchedEffect
        delay(OPERATOR_KEY_WAIT_MS)
        if (OperatorKey.consume()) Toast.makeText(appContext, R.string.operator_section_off, Toast.LENGTH_LONG).show()
    }

    // The AI Key's walkie-talkie target: the open session, else the operator.
    val onScreenThread = home.selectedSessionId
        ?: (state.operator as? OperatorSummary.On)?.id?.takeIf { home.homeTab == HomeTab.Helm }
    val viewedChat = onScreenThread?.takeIf { home.destination == Destination.Thread }
    val talkTarget = home.selectedSessionId ?: (state.operator as? OperatorSummary.On)?.id
    LaunchedEffect(talkTarget) { PttKey.target = talkTarget }
    ReportViewedChat(client, viewedChat)
    LaunchedEffect(onScreenThread, home.destination) {
        val reading = home.destination == Destination.Thread ||
            home.destination == Destination.ArtifactDetail || home.destination == Destination.ArtifactEditor
        client.sessions.chats.reading(onScreenThread?.takeIf { reading })
    }

    // Projects are the key every project-scoped ask needs. Pull once on arrival,
    // never poll. Include the link so a failed pre-connect ask retries when the
    // link comes up; keying on failure itself would retry forever after each failure.
    LaunchedEffect(home.homeTab, home.selectedSessionId, state.linkState) {
        val unasked = state.projects is ProjectList.Idle || state.projects is ProjectList.Failed
        if (home.selectedSessionId == null && (home.homeTab == HomeTab.Plans || home.homeTab == HomeTab.Contexts) && unasked) {
            client.workspace.refreshProjects()
        }
    }
    // Plan, sequence and context surfaces pull on arrival, never as streams or
    // stale-cache reads. Tab, project or session changes each count as arrival.
    LaunchedEffect(home.destination, home.sessionTab, home.homeTab, home.selectedSessionId, state.planDirPath, state.contextProjectId) {
        if (home.destination != Destination.Thread) return@LaunchedEffect
        val inSession = home.selectedSessionId != null
        val showingPlans = if (inSession) home.sessionTab == SessionTab.Plans else home.homeTab == HomeTab.Plans
        val showingContexts = !inSession && home.homeTab == HomeTab.Contexts
        if (showingPlans && state.planDirPath != null) {
            // Two asks answer two things: rows and the lanes they group into.
            // The rows already carry the frontier edges, so there is no third ask.
            client.plans.refreshPlans(state.planDirPath)
            client.plans.refreshSequences(state.planDirPath)
            client.plans.refreshCleanupCounts(state.planDirPath)
        }
        if (showingContexts && state.contextProjectId != null) client.plans.refreshContexts(state.contextProjectId)
    }
    LaunchedEffect(home.destination, home.openPlanId) {
        val planId = home.openPlanId
        if (home.destination == Destination.PlanDetail && planId != null) {
            client.plans.readPlan(planId)
            client.plans.refreshPlanContexts(planId)
        }
    }
    LaunchedEffect(home.destination, home.openSequenceId) {
        val sequenceId = home.openSequenceId
        if (home.destination == Destination.SequenceDetail && sequenceId != null) client.plans.readSequence(sequenceId)
    }
    LaunchedEffect(home.destination, home.openContextId) {
        val contextId = home.openContextId
        if (home.destination == Destination.ContextDetail && contextId != null) client.plans.readContext(contextId)
    }

    // Ask when a control surface needs permissions, and forget them with the
    // link so reconnect re-asks. The list, sheet and artifact controls all use
    // the answer to show or disable their actions.
    LaunchedEffect(home.destination, home.sessionTab, home.selectedSessionId, state.capabilities) {
        val listShowing = home.selectedSessionId == null && home.destination != Destination.Spawn
        val artifactsShowing = (home.destination == Destination.Thread && home.sessionTab == SessionTab.Artifacts) ||
            home.destination == Destination.ArtifactDetail || home.destination == Destination.ArtifactEditor
        if ((home.destination == Destination.Sheet || listShowing || artifactsShowing) && state.capabilities is Capabilities.Unknown) {
            client.workspace.refreshCapabilities()
        }
    }
    // Sheet needs the current desktop's CLIs. Spawn's machine callback reloads
    // that machine's directories and CLIs; artifact rows are fresh on arrival.
    LaunchedEffect(home.destination, home.sessionTab, home.selectedSessionId) {
        when {
            home.destination == Destination.Sheet ->
                if (state.clis.isEmpty() || !client.workspace.control.wantsClisOf(null)) client.workspace.refreshClis()
            home.destination == Destination.Spawn -> {
                if (state.directories.isEmpty() || !client.workspace.control.wantsDirectoriesOf(null)) client.workspace.refreshDirectories()
                if (state.clis.isEmpty() || !client.workspace.control.wantsClisOf(null)) client.workspace.refreshClis()
                client.workspace.refreshMachines()
            }
            // Returning to the artifacts tab is an arrival and must pull its rows again.
            home.destination == Destination.Thread && home.sessionTab == SessionTab.Artifacts ->
                home.selectedSessionId?.let { client.artifacts.refreshArtifacts(it) }
            home.destination == Destination.ArtifactDetail ->
                if (home.selectedSessionId != null && home.openArtifactId != null) {
                    client.artifacts.readArtifact(home.selectedSessionId!!, home.openArtifactId!!, version = null)
                }
            else -> Unit
        }
    }

    // A spawn Helm confirmed names the session it made, and that id is how the
    // new thread opens. The opening WAITS until the row is actually in the
    // list: jumping straight there would trip the went-away fallback above (the
    // refreshed list has not arrived yet) and dump the user back on the list.
    // A session that never appears gives up quietly — the notice bar has
    // already said the spawn succeeded, and the list is one refresh away.
    // A transferred call takes the user along: whoever was looking at the chat
    // the call left lands on the chat it moved to. Waits for the row like a
    // fresh spawn does, so the went-away fallback does not fire first.
    var lastCallTarget by androidx.compose.runtime.remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.liveCall?.targetId, callScreenTarget) {
        val to = state.liveCall?.targetId
        val from = lastCallTarget
        lastCallTarget = to
        if (to == null || from == null || to == from || callScreenTarget != from) return@LaunchedEffect
        var waits = 0
        while (client.sessions.state.sessions.value.none { it.id == to } && waits < CREATED_SESSION_WAITS) {
            delay(SESSION_WAIT_STEP_MS)
            waits++
        }
        home.followCallTarget(to)
    }
    LaunchedEffect(state.createdSessionId) {
        val id = state.createdSessionId ?: return@LaunchedEffect
        var waits = 0
        // No refreshSessions() here on purpose: the spawn's own answer already
        // refreshed the list, and Helm announces the new row besides. This only
        // watches what is held.
        while (client.sessions.state.sessions.value.none { it.id == id } && waits < CREATED_SESSION_WAITS) {
            delay(SESSION_WAIT_STEP_MS)
            waits++
        }
        client.workspace.control.clearCreatedSession(id)
        // Wait for the announced row before opening it; opening sooner looks like
        // a vanished session. Treat it like a row tap and discard old artifact state.
        if (client.sessions.state.sessions.value.any { it.id == id }) home.openCreatedSession(id)
    }

    // An artifact write that LANDED moves the user once. Create opens the new
    // artifact's detail; revise returns to the detail it came from (which
    // re-pulls the fresh body on arrival); delete returns to the list (which
    // re-pulls without the row). Consumed exactly once, so two identical
    // outcomes both navigate and a rotation does not drag anyone anywhere.
    LaunchedEffect(state.artifactLanding) {
        val landing = state.artifactLanding ?: return@LaunchedEffect
        client.workspace.control.consumeArtifactLanding()
        when (landing.action) {
            SessionAction.CreateArtifact -> {
                if (landing.artifactId == null) {
                    // The answer named no artifact; the list is where the new
                    // row is one pull away.
                    home.destination = Destination.Thread
                } else {
                    home.openArtifactId = landing.artifactId
                    home.editingArtifactId = null
                    home.editingShown = null
                    home.destination = Destination.ArtifactDetail
                }
                // The landing that arrives here AFTER a staged create is the
                // chain's own "everything is attached" moment (the client
                // defers it until then) — so this is where the chips retire.
                // Waiting chips of a plain create go with them: they described
                // one create, which is over.
                client.artifacts.uploads.clear()
            }
            SessionAction.ReviseArtifact -> {
                home.editingArtifactId = null
                home.editingShown = null
                home.destination = Destination.ArtifactDetail
            }
            SessionAction.DeleteArtifact -> home.destination = Destination.Thread
            else -> Unit
        }
    }
    LaunchedEffect(state.artifactSave) {
        val ready = state.artifactSave as? ArtifactSave.Ready ?: return@LaunchedEffect
        try {
            val path = withContext(Dispatchers.IO) {
                state.artifactFiles.save(ready.file.filename, ready.file.mimeType, ready.file.bytes)
            }
            // Done first: saveLanded changes artifactSave, which cancels this effect.
            client.workspace.control.noticed(SessionAction.SaveArtifact, ActionOutcome.Done)
            client.artifacts.state.saveLanded(ready.file.artifactId, path.location)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            client.artifacts.state.saveFailed(ready.file.artifactId, error.message ?: CANNOT_WRITE_FILE)
        }
    }
    LaunchedEffect(state.shareState) {
        when (val current = state.shareState) {
            is ShareState.Failed -> if (state.chatAttachSession.value != null) {
                Toast.makeText(appContext, current.message, Toast.LENGTH_LONG).show()
                state.chatAttachSession.value = null
            }
            is ShareState.Cancelled -> if (state.chatAttachSession.value != null) {
                Toast.makeText(appContext, R.string.share_cancelled, Toast.LENGTH_SHORT).show()
                state.chatAttachSession.value = null
            }
            else -> Unit
        }
    }
    LaunchedEffect(home.destination) {
        if (home.destination != Destination.Spawn) home.planSpawn = null
    }
    // Plan/sequence writes (P-0812). Each needs the board's directory so the
    // client can re-pull it on success; with no directory there is no board.
    LaunchedEffect(state.planWrite) {
        val done = state.planWrite as? PlanWrite.Done ?: return@LaunchedEffect
        if ((done.kind == PlanWriteKind.DeletePlan || done.kind == PlanWriteKind.RejectSuggestion) && home.destination == Destination.PlanDetail) {
            home.destination = Destination.Thread
        }
        if (done.kind == PlanWriteKind.DeleteSequence && home.destination == Destination.SequenceDetail) home.destination = Destination.Thread
    }
    LaunchedEffect(home.destination, state.edit) {
        if (home.destination == Destination.ArtifactEditor && state.edit == null) home.destination = Destination.Thread
    }
}

/**
 * Tell the client whether the user can see sessions — and ONLY while they can.
 *
 * This is not a poll. The client fetches the list once when it is watched, and
 * again only when Helm says it moved (a `changes` record). TWO conditions gate
 * the watching: the lifecycle scope (STARTED), so a phone in a pocket asks for
 * nothing, and [active], so a fetch never lands between attachment slices.
 *
 * The loop retries a fetch that could not be made. While the list is fresh each
 * pass does nothing, and with no link it puts nothing on the air.
 */
@Composable
internal fun WatchSessions(client: HelmClient, active: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, active) {
        if (!active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            client.sessions.watchSessions(true)
            try {
                while (true) {
                    delay(STALE_SESSIONS_RETRY_MS)
                    client.sessions.refreshStaleSessions()
                }
            } finally {
                client.sessions.watchSessions(false)
            }
        }
    }
}

/** Report a thread as visible only while the app is resumed and its window has focus. */
@Composable
internal fun ReportViewedChat(client: HelmClient, viewedChat: String?) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(client, lifecycle, viewedChat, windowFocused) {
        if (!windowFocused) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            client.sessions.alerts.viewed(viewedChat)
            try {
                awaitCancellation()
            } finally {
                client.sessions.alerts.viewed(null)
            }
        }
    }
}

private const val STALE_SESSIONS_RETRY_MS = 2_000L

/** How long a "Call operator" press waits for a cold-starting link to list the operator. */
private const val OPERATOR_KEY_WAIT_MS = 10_000L

/** How often a screen waiting for a session to appear looks at the held list. */
private const val SESSION_WAIT_STEP_MS = 500L

/**
 * How long a confirmed spawn waits for its session to show in the list before
 * giving up on opening the thread: [CREATED_SESSION_WAITS] looks, one every
 * [SESSION_WAIT_STEP_MS]. The spawn's own refresh normally brings the row at
 * once — this is the rope, not the path.
 */
private const val CREATED_SESSION_WAITS = 40

/** The sink threw with no message of its own; the row still needs a reason. */
internal const val CANNOT_WRITE_FILE = "The phone could not write the file"
