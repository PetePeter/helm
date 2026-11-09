package com.potatomotato.helm.ui

import androidx.compose.runtime.saveable.SaverScope
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.components.HomeTab
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.plans.PlanSpawn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HelmHomeStateTest {

    @Test
    fun `row selection resets chat while preserving other state`() {
        val state = populatedState()
        val before = state.snapshot()

        state.selectSession("row")

        assertEquals(before.copy(selectedSessionId = "row", sessionTab = SessionTab.Chat), state.snapshot())
    }

    @Test
    fun `long press selects row and opens its sheet`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openSessionSheet("long-pressed")

        assertEquals(
            before.copy(selectedSessionId = "long-pressed", sessionTab = SessionTab.Chat, destination = Destination.Sheet),
            state.snapshot(),
        )
    }

    @Test
    fun `task link opens builder chat on thread`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openTaskSession("builder")

        assertEquals(
            before.copy(selectedSessionId = "builder", sessionTab = SessionTab.Chat, destination = Destination.Thread),
            state.snapshot(),
        )
    }

    @Test
    fun `operator tasks open that session plans tab`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openOperatorTasks("operator")

        assertEquals(
            before.copy(selectedSessionId = "operator", sessionTab = SessionTab.Plans, destination = Destination.Thread),
            state.snapshot(),
        )
    }

    @Test
    fun `notification selects requested tab and returns to thread`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openNotification("notified", artifacts = true)

        assertEquals(
            before.copy(selectedSessionId = "notified", sessionTab = SessionTab.Artifacts, destination = Destination.Thread),
            state.snapshot(),
        )

        val chatState = populatedState()
        val chatBefore = chatState.snapshot()
        chatState.openNotification("chat-notified", artifacts = false)
        assertEquals(
            chatBefore.copy(selectedSessionId = "chat-notified", sessionTab = SessionTab.Chat, destination = Destination.Thread),
            chatState.snapshot(),
        )
    }

    @Test
    fun `call target follows chat while preserving current destination`() {
        val state = populatedState()
        val before = state.snapshot()

        state.followCallTarget("call-target")

        assertEquals(before.copy(selectedSessionId = "call-target", sessionTab = SessionTab.Chat), state.snapshot())
    }

    @Test
    fun `spawned session opens a fresh thread without old artifact edit`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openCreatedSession("created")

        assertEquals(
            before.copy(
                selectedSessionId = "created",
                destination = Destination.Thread,
                sessionTab = SessionTab.Chat,
                openArtifactId = null,
                editingArtifactId = null,
                editingShown = null,
            ),
            state.snapshot(),
        )
    }

    @Test
    fun `snapshot callback navigates before pulling the requested line count`() {
        val state = populatedState()
        val before = state.snapshot()
        var requested: Pair<String, Int>? = null
        var stateAtPull: HomeSnapshot? = null

        val handled = applyPhoneSheetAction(
            state = state,
            action = SessionAction.Snapshot,
            sessionId = "open-session",
            requestedLines = 37,
            readTerminal = { id, lines ->
                requested = id to lines
                stateAtPull = state.snapshot()
            },
            dial = { error("Snapshot must not dial") },
        )

        assertTrue(handled)
        assertEquals(before.copy(destination = Destination.Snapshot), state.snapshot())
        assertEquals(before.copy(destination = Destination.Snapshot), stateAtPull)
        assertEquals("open-session" to 37, requested)
    }

    @Test
    fun `plan routes preserve task session and existing tab`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openPlanFromTask("task-plan", builderSessionId = "builder")

        assertEquals(
            before.copy(selectedSessionId = "builder", openPlanId = "task-plan", destination = Destination.PlanDetail),
            state.snapshot(),
        )

        val rootState = populatedState()
        val rootBefore = rootState.snapshot()
        rootState.openPlan("root-plan")
        assertEquals(rootBefore.copy(openPlanId = "root-plan", destination = Destination.PlanDetail), rootState.snapshot())
    }

    @Test
    fun `plan task without a builder leaves selected session unchanged`() {
        val state = populatedState()
        val before = state.snapshot()

        state.openPlanFromTask("task-plan", builderSessionId = null)

        assertEquals(before.copy(openPlanId = "task-plan", destination = Destination.PlanDetail), state.snapshot())
    }

    @Test
    fun `sheet Call returns to chat before dialing`() {
        val state = populatedState()
        val before = state.snapshot()
        var dialed: String? = null
        var stateAtDial: HomeSnapshot? = null

        val handled = applyPhoneSheetAction(
            state = state,
            action = SessionAction.Call,
            sessionId = "open-session",
            requestedLines = 0,
            readTerminal = { _, _ -> error("Call must not pull a snapshot") },
            dial = {
                dialed = it
                stateAtDial = state.snapshot()
            },
        )

        assertTrue(handled)
        assertEquals(before.copy(sessionTab = SessionTab.Chat), stateAtDial)
        assertEquals(before.copy(destination = Destination.Thread, sessionTab = SessionTab.Chat), state.snapshot())
        assertEquals("open-session", dialed)
    }

    @Test
    fun `unhandled sheet action leaves transition to its caller`() {
        val state = populatedState()
        val before = state.snapshot()
        var sideEffectCalled = false

        val handled = applyPhoneSheetAction(
            state = state,
            action = SessionAction.Spawn,
            sessionId = "open-session",
            requestedLines = 0,
            readTerminal = { _, _ -> sideEffectCalled = true },
            dial = { sideEffectCalled = true },
        )

        assertFalse(handled)
        assertEquals(before, state.snapshot())
        assertFalse(sideEffectCalled)
    }

    @Test
    fun `toThread changes only the destination`() {
        val state = populatedState()
        val before = state.snapshot()

        state.toThread()

        assertEquals(before.copy(destination = Destination.Thread), state.snapshot())
    }

    @Test
    fun `restored session-only route stays at root until its row arrives`() {
        val restored = roundTrip(HelmHomeState().apply {
            selectedSessionId = "restored-session"
            destination = Destination.ArtifactEditor
            editingArtifactId = "draft"
            editingShown = "half-written"
        })

        restored.clearMissingSession(isSelectedSessionPresent = false, sessionsNotEmpty = false)

        assertEquals("restored-session", restored.selectedSessionId)
        assertEquals(Destination.ArtifactEditor, restored.destination)
        assertEquals(PhoneScaffoldSurface.Root, phoneScaffoldSurface(restored.destination, hasOpenSession = false))
        assertEquals(PhoneScaffoldSurface.FullScreen, phoneScaffoldSurface(restored.destination, hasOpenSession = true))
        listOf(Destination.Snapshot, Destination.ArtifactDetail, Destination.ArtifactEditor).forEach { destination ->
            assertEquals(PhoneScaffoldSurface.Root, phoneScaffoldSurface(destination, hasOpenSession = false))
            assertEquals(PhoneScaffoldSurface.FullScreen, phoneScaffoldSurface(destination, hasOpenSession = true))
        }
        listOf(
            Destination.Desktops,
            Destination.Pairing,
            Destination.Spawn,
            Destination.PlanDetail,
            Destination.SequenceDetail,
            Destination.ContextDetail,
        ).forEach { destination ->
            assertEquals(PhoneScaffoldSurface.FullScreen, phoneScaffoldSurface(destination, hasOpenSession = false))
        }
    }

    @Test
    fun `missing session falls back after nonempty session data arrives`() {
        val state = HelmHomeState().apply {
            selectSession("gone")
            navigateTo(Destination.Snapshot)
        }

        state.clearMissingSession(isSelectedSessionPresent = false, sessionsNotEmpty = false)
        assertEquals("gone", state.selectedSessionId)
        assertEquals(Destination.Snapshot, state.destination)

        state.clearMissingSession(isSelectedSessionPresent = false, sessionsNotEmpty = true)
        assertNull(state.selectedSessionId)
        assertEquals(Destination.Thread, state.destination)
    }

    @Test
    fun `Saver round trip keeps every saved selection and navigation field`() {
        val state = HelmHomeState().apply {
            selectedSessionId = "session"
            destination = Destination.ArtifactEditor
            sessionTab = SessionTab.Artifacts
            openArtifactId = "artifact"
            editingArtifactId = "revision"
            editingShown = null
            homeTab = HomeTab.Contexts
            tabTrail = listOf(HomeTab.Sessions, HomeTab.Plans)
            chosenProjectId = "project"
            openPlanId = "plan"
            planSpawn = PlanSpawn("/project", "Planned spawn", "Start with this context")
            collapsedLanes = setOf("lane-z", "lane-a")
            openSequenceId = "sequence"
            openContextId = "context"
            sessionSwipeDirection = -1
            sessionSwipeTargetId = "swipe"
            edgeBounceDirection = 1
            edgeBounceRequest = 3
            leaving = true
        }

        val restored = roundTrip(state)

        assertEquals("session", restored.selectedSessionId)
        assertEquals(Destination.ArtifactEditor, restored.destination)
        assertEquals(SessionTab.Artifacts, restored.sessionTab)
        assertEquals("artifact", restored.openArtifactId)
        assertEquals("revision", restored.editingArtifactId)
        assertNull(restored.editingShown)
        assertEquals(HomeTab.Contexts, restored.homeTab)
        assertEquals(listOf(HomeTab.Sessions, HomeTab.Plans), restored.tabTrail)
        assertEquals("project", restored.chosenProjectId)
        assertEquals("plan", restored.openPlanId)
        assertEquals(PlanSpawn("/project", "Planned spawn", "Start with this context"), restored.planSpawn)
        assertEquals(setOf("lane-a", "lane-z"), restored.collapsedLanes)
        assertEquals("sequence", restored.openSequenceId)
        assertEquals("context", restored.openContextId)

        assertEquals(0, restored.sessionSwipeDirection)
        assertNull(restored.sessionSwipeTargetId)
        assertEquals(0, restored.edgeBounceDirection)
        assertEquals(0, restored.edgeBounceRequest)
        assertFalse(restored.leaving)
    }

    @Test
    fun `Saver distinguishes null editor text from empty editor text`() {
        val nullBody = roundTrip(HelmHomeState().apply { editingShown = null })
        val emptyBody = roundTrip(HelmHomeState().apply { editingShown = "" })

        assertNull(nullBody.editingShown)
        assertNull(nullBody.selectedSessionId)
        assertNull(nullBody.openArtifactId)
        assertNull(nullBody.editingArtifactId)
        assertNull(nullBody.chosenProjectId)
        assertNull(nullBody.openPlanId)
        assertNull(nullBody.planSpawn)
        assertNull(nullBody.openSequenceId)
        assertNull(nullBody.openContextId)
        assertEquals("", emptyBody.editingShown)
    }

    @Test
    fun `swipe follows listed order and stops at both ends`() {
        val ids = listOf("first", "middle", "last")
        val state = HelmHomeState().apply { selectSession("middle") }

        assertTrue(state.swipeSession(ids, "middle", step = 1, canSwipe = true))
        assertEquals("last", state.selectedSessionId)
        assertTrue(state.swipeSession(ids, "last", step = -1, canSwipe = true))
        assertEquals("middle", state.selectedSessionId)
        assertTrue(state.swipeSession(ids, "middle", step = -1, canSwipe = true))
        assertEquals("first", state.selectedSessionId)
        assertFalse(state.swipeSession(ids, "first", step = -1, canSwipe = true))
        assertEquals("first", state.selectedSessionId)
        assertEquals(1, state.edgeBounceRequest)
    }

    private fun roundTrip(state: HelmHomeState): HelmHomeState {
        val scope = object : SaverScope {
            override fun canBeSaved(value: Any): Boolean = true
        }
        val saved = HelmHomeState.Saver.run { scope.save(state) }!!
        return HelmHomeState.Saver.restore(saved)!!
    }

    private fun populatedState() = HelmHomeState().apply {
        selectedSessionId = "before"
        destination = Destination.ArtifactDetail
        sessionTab = SessionTab.Artifacts
        openArtifactId = "artifact-before"
        editingArtifactId = "edit-before"
        editingShown = "body-before"
        homeTab = HomeTab.Plans
        tabTrail = listOf(HomeTab.Sessions, HomeTab.Helm)
        chosenProjectId = "project-before"
        openPlanId = "plan-before"
        planSpawn = PlanSpawn("/before", "Before", "Keep this")
        collapsedLanes = setOf("lane-before")
        openSequenceId = "sequence-before"
        openContextId = "context-before"
        sessionSwipeDirection = -1
        sessionSwipeTargetId = "swipe-before"
        edgeBounceDirection = 1
        edgeBounceRequest = 4
        leaving = true
    }

    private fun HelmHomeState.snapshot() = HomeSnapshot(
        selectedSessionId = selectedSessionId,
        destination = destination,
        sessionTab = sessionTab,
        openArtifactId = openArtifactId,
        editingArtifactId = editingArtifactId,
        editingShown = editingShown,
        homeTab = homeTab,
        tabTrail = tabTrail,
        chosenProjectId = chosenProjectId,
        openPlanId = openPlanId,
        planSpawn = planSpawn,
        collapsedLanes = collapsedLanes,
        openSequenceId = openSequenceId,
        openContextId = openContextId,
        sessionSwipeDirection = sessionSwipeDirection,
        sessionSwipeTargetId = sessionSwipeTargetId,
        edgeBounceDirection = edgeBounceDirection,
        edgeBounceRequest = edgeBounceRequest,
        leaving = leaving,
    )

    private data class HomeSnapshot(
        val selectedSessionId: String?,
        val destination: Destination,
        val sessionTab: SessionTab,
        val openArtifactId: String?,
        val editingArtifactId: String?,
        val editingShown: String?,
        val homeTab: HomeTab,
        val tabTrail: List<HomeTab>,
        val chosenProjectId: String?,
        val openPlanId: String?,
        val planSpawn: PlanSpawn?,
        val collapsedLanes: Set<String>,
        val openSequenceId: String?,
        val openContextId: String?,
        val sessionSwipeDirection: Int,
        val sessionSwipeTargetId: String?,
        val edgeBounceDirection: Int,
        val edgeBounceRequest: Int,
        val leaving: Boolean,
    )
}
