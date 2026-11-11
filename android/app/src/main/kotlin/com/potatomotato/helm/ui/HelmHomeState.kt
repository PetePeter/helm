package com.potatomotato.helm.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.listSaver
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.components.HomeTabHistory
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.plans.PlanSpawn
import com.potatomotato.helm.ui.sessions.SessionRows

/**
 * Where an open session can take you. One straight path still — the sheet and
 * the screens it opens all hang off [Thread], never off each other.
 *
 * [Thread] is not chat alone: it is the session's TAB surface (chat or artifact
 * list, see [SessionTab]), which is why artifact detail and editor return to it.
 * Plans, sequences and contexts also sit beside [Spawn] and [Desktops]: they
 * are reachable from root tabs without a session, and back returns to [Thread].
 */
internal enum class Destination {
    Thread,
    Sheet,
    Snapshot,
    Spawn,
    ArtifactDetail,
    ArtifactEditor,
    Desktops,
    Pairing,
    PlanDetail,
    SequenceDetail,
    ContextDetail,
}

/**
 * Navigation is a nullable session id plus a destination rather than a nav
 * library: the graph is a star around one thread, and a graph definition would
 * be more machinery than the thing it describes. Both are saveable so a
 * rotation does not drop the user back to the list or out of a detail screen.
 */
internal class HelmHomeState {
    /** Saveable so rotation returns to the selected session instead of the list. */
    var selectedSessionId by mutableStateOf<String?>(null)
    var destination by mutableStateOf(Destination.Thread)

    /**
     * Which open-session tab is showing. Saveable with [destination] so a
     * rotation does not drop someone reading the artifact list back into chat.
     */
    var sessionTab by mutableStateOf(SessionTab.Chat)
    var openArtifactId by mutableStateOf<String?>(null)

    /**
     * Keep the editor mode and shown body through recreation or process death so
     * a half-written revise cannot turn into a create. The id chooses the mode
     * and the body is the revise starting point; the artifact is re-derived from
     * the list, which is pulled again on arrival.
     */
    var editingArtifactId by mutableStateOf<String?>(null)
    var editingShown by mutableStateOf<String?>(null)

    /** Saveable like [sessionTab], so rotation does not drop the root board to the list. */
    var homeTab by mutableStateOf(HomeTab.Sessions)
    /** Back retraces the root tabs the user picked before asking to exit. */
    var tabTrail by mutableStateOf(emptyList<HomeTab>())
    /** Keep the selected root project across rotation instead of silently choosing another. */
    var chosenProjectId by mutableStateOf<String?>(null)
    var openPlanId by mutableStateOf<String?>(null)

    /** A plan-targeted spawn is forgotten when its form is left. */
    var planSpawn by mutableStateOf<PlanSpawn?>(null)

    /**
     * Keep folded lanes saved and shared across root and session plan surfaces;
     * otherwise rotation reopens the lanes, and the board cannot stay stateless.
     */
    var collapsedLanes by mutableStateOf(emptySet<String>())
    var openSequenceId by mutableStateOf<String?>(null)
    var openContextId by mutableStateOf<String?>(null)

    // Swipe animation coordination and the exit question intentionally do not
    // survive recreation, matching their former remember-backed ownership.
    var sessionSwipeDirection by mutableStateOf(0)
    var sessionSwipeTargetId by mutableStateOf<String?>(null)
    var edgeBounceDirection by mutableStateOf(0)
    var edgeBounceRequest by mutableStateOf(0)
    // Deliberately not saved: a rotation must not redraw a question the user
    // never asked, and back is one tap away if they still mean it.
    var leaving by mutableStateOf(false)

    /** A notification chooses its requested session tab and always returns to the thread surface. */
    fun openNotification(sessionId: String, artifacts: Boolean) {
        selectedSessionId = sessionId
        sessionTab = if (artifacts) SessionTab.Artifacts else SessionTab.Chat
        destination = Destination.Thread
    }

    /** A normal session entry opens chat, while leaving the current destination alone. */
    fun selectSession(sessionId: String) {
        selectedSessionId = sessionId
        sessionTab = SessionTab.Chat
    }

    /** A long press selects the row and opens its session actions. */
    fun openSessionSheet(sessionId: String) {
        selectSession(sessionId)
        destination = Destination.Sheet
    }

    /** Operator tasks are the plan tab for that operator's own session. */
    fun openOperatorTasks(sessionId: String) {
        selectedSessionId = sessionId
        sessionTab = SessionTab.Plans
        destination = Destination.Thread
    }

    /** A task link explicitly returns to the thread as it opens the builder's chat. */
    fun openTaskSession(sessionId: String) {
        selectedSessionId = sessionId
        sessionTab = SessionTab.Chat
        destination = Destination.Thread
    }

    /** Select chat before a sheet Call dials; its callback returns to Thread after dialing. */
    fun prepareSheetCall() {
        sessionTab = SessionTab.Chat
    }

    /** Call arrival follows the target but preserves the current destination. */
    fun followCallTarget(sessionId: String) {
        selectedSessionId = sessionId
        sessionTab = SessionTab.Chat
    }

    /** A confirmed spawn is a fresh thread and must discard the previous artifact edit. */
    fun openCreatedSession(sessionId: String) {
        selectedSessionId = sessionId
        sessionTab = SessionTab.Chat
        openArtifactId = null
        editingArtifactId = null
        editingShown = null
        destination = Destination.Thread
    }

    /** Keep task plan links' optional session selection distinct from chat entry. */
    fun openPlanFromTask(planId: String, builderSessionId: String?) {
        if (builderSessionId != null) selectedSessionId = builderSessionId
        openPlanId = planId
        destination = Destination.PlanDetail
    }

    /** Keep a drag-selected target when present; otherwise use the adjacent listed session. */
    fun swipeSession(sessionIds: List<String>, currentId: String, step: Int, canSwipe: Boolean): Boolean {
        if (!canSwipe) return false
        val next = sessionSwipeTargetId
            ?.takeIf { it in sessionIds && it != currentId }
            ?: SessionRows.adjacentSessionId(sessionIds, currentId, step)
        if (next == null) {
            edgeBounceDirection = -step
            edgeBounceRequest++
            return false
        }
        val distance = sessionIds.indexOf(next) - sessionIds.indexOf(currentId)
        sessionSwipeDirection = -distance.compareTo(0)
        sessionSwipeTargetId = null
        selectedSessionId = next
        return true
    }

    /**
     * An empty list can mean restored data has not arrived yet, so retain the
     * selection then. Once a non-empty list proves the row vanished, return to
     * the list instead of leaving an unreplyable thread open.
     */
    fun clearMissingSession(isSelectedSessionPresent: Boolean, sessionsNotEmpty: Boolean) {
        if (selectedSessionId != null && !isSelectedSessionPresent && sessionsNotEmpty) {
            selectedSessionId = null
            destination = Destination.Thread
        }
    }

    fun clearSessionSelection() {
        selectedSessionId = null
    }

    fun openNewSessionForm() {
        selectedSessionId = null
        destination = Destination.Spawn
    }

    fun navigateTo(value: Destination) {
        destination = value
    }

    /** Start the snapshot screen; its caller separately issues the terminal pull. */
    fun openSnapshot() {
        destination = Destination.Snapshot
    }

    /** Return to the thread surface while leaving selection and tabs intact. */
    fun toThread() {
        destination = Destination.Thread
    }

    fun chooseSessionTab(value: SessionTab) {
        sessionTab = value
    }

    fun selectHomeTab(value: HomeTab) {
        tabTrail = HomeTabHistory(tabTrail).pick(homeTab, value).trail
        homeTab = value
    }

    fun backAtRoot(exitAlreadyPrompted: Boolean) {
        val previous = HomeTabHistory(tabTrail).back()
        if (previous == null || exitAlreadyPrompted) {
            leaving = !leaving
        } else {
            homeTab = previous.first
            tabTrail = previous.second.trail
        }
    }

    fun updateSwipeTarget(value: String?) {
        sessionSwipeTargetId = value
    }

    fun finishSwipeAnimation() {
        sessionSwipeDirection = 0
    }

    fun toggleLane(laneId: String) {
        collapsedLanes = if (laneId in collapsedLanes) collapsedLanes - laneId else collapsedLanes + laneId
    }

    fun selectProject(projectId: String?) {
        chosenProjectId = projectId
    }

    fun openPlan(planId: String) {
        openPlanId = planId
        destination = Destination.PlanDetail
    }

    fun openSequence(sequenceId: String) {
        openSequenceId = sequenceId
        destination = Destination.SequenceDetail
    }

    fun openContext(contextId: String) {
        openContextId = contextId
        destination = Destination.ContextDetail
    }

    fun selectArtifact(artifactId: String) {
        openArtifactId = artifactId
        destination = Destination.ArtifactDetail
    }

    fun startArtifactCreate() {
        editingArtifactId = null
        editingShown = null
        destination = Destination.ArtifactEditor
    }

    fun startArtifactEdit(artifactId: String?, shown: String?) {
        editingArtifactId = artifactId
        editingShown = shown
        destination = Destination.ArtifactEditor
    }

    companion object {
        val Saver = listSaver<HelmHomeState, String>(
            save = {
                listOf(
                    it.selectedSessionId.orEmpty(), it.destination.name, it.sessionTab.name,
                    it.openArtifactId.orEmpty(), it.editingArtifactId.orEmpty(),
                    if (it.editingShown == null) "0" else "1", it.editingShown.orEmpty(),
                    it.homeTab.name, it.tabTrail.joinToString(",") { tab -> tab.name },
                    it.chosenProjectId.orEmpty(), it.openPlanId.orEmpty(),
                    if (it.planSpawn == null) "0" else "1",
                    it.planSpawn?.dirPath.orEmpty(), it.planSpawn?.name.orEmpty(), it.planSpawn?.prompt.orEmpty(),
                    it.collapsedLanes.sorted().joinToString("\u0000"),
                    it.openSequenceId.orEmpty(), it.openContextId.orEmpty(),
                )
            },
            restore = { saved ->
                HelmHomeState().apply {
                    selectedSessionId = saved[0].ifEmpty { null }
                    destination = Destination.valueOf(saved[1])
                    sessionTab = SessionTab.entries.firstOrNull { it.name == saved[2] } ?: SessionTab.Plans
                    openArtifactId = saved[3].ifEmpty { null }
                    editingArtifactId = saved[4].ifEmpty { null }
                    editingShown = if (saved[5] == "1") saved[6] else null
                    homeTab = HomeTab.valueOf(saved[7])
                    tabTrail = saved[8].split(',').filter(String::isNotEmpty).map(HomeTab::valueOf)
                    chosenProjectId = saved[9].ifEmpty { null }
                    openPlanId = saved[10].ifEmpty { null }
                    planSpawn = if (saved[11] == "1") PlanSpawn(saved[12], saved[13], saved[14]) else null
                    collapsedLanes = saved[15].split('\u0000').filter(String::isNotEmpty).toSet()
                    openSequenceId = saved[16].ifEmpty { null }
                    openContextId = saved[17].ifEmpty { null }
                }
            },
        )
    }
}
