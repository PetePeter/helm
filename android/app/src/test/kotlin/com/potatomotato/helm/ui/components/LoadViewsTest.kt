package com.potatomotato.helm.ui.components

import com.potatomotato.helm.data.ContextDetail
import com.potatomotato.helm.data.ContextList
import com.potatomotato.helm.data.ContextPermission
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.HelmPlanContextRef
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.data.PlanContextRefs
import com.potatomotato.helm.data.PlanDetail
import com.potatomotato.helm.data.PlanList
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.SequenceDetail
import com.potatomotato.helm.data.SequenceList
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The scope check is what these pin.
 *
 * Every repository here keeps ONE state machine shared by every scope, so the
 * moment the user switches project the flow still carries the previous scope's
 * answer. Drawing that under the new project's name is a WRONG answer, which is
 * the failure worth a test — the state-to-view mapping either side of it is
 * mechanical, and is exercised only as the vehicle for the key comparison.
 */
class LoadViewsTest {

    private val here = "X:/work/alpha"
    private val elsewhere = "X:/work/beta"

    /** A board ROW — what the list state holds, and what `plan_summary` answers. */
    private fun row(id: String) = HelmPlanSummary(
        id = id,
        humanId = "P-0001",
        title = "A plan",
        type = null,
        status = PlanStatus.Ready,
        stateUpdatedAtEpochMs = null,
        sequenceId = null,
        blockedBy = emptyList(),
        blocks = emptyList(),
    )

    /** A FULL plan — what the detail state holds, and what `plan_get` answers. */
    private fun plan(id: String, dirPath: String = here) = HelmPlan(
        id = id,
        humanId = "P-0001",
        projectId = "proj",
        dirPath = dirPath,
        title = "A plan",
        description = "",
        status = PlanStatus.Ready,
        stateInfo = null,
        completionNotes = null,
        type = null,
        autoImplement = null,
        completionRecap = null,
        sequenceId = null,
        sessionId = null,
        createdAtEpochMs = 0L,
        stateUpdatedAtEpochMs = null,
        updatedAtEpochMs = 0L,
    )

    private fun lane(id: String, dirPath: String = here) = HelmPlanSequence(
        id = id,
        projectId = "proj",
        dirPath = dirPath,
        title = "A lane",
        missionStatement = "",
        sharedMemory = "",
        order = 0,
    )

    private fun node(id: String, projectId: String) = HelmContext(
        id = id,
        projectId = projectId,
        title = "A node",
        type = "Coding",
        permission = ContextPermission.Readonly,
        content = "body",
        x = null,
        y = null,
        createdAtEpochMs = 0L,
        updatedAtEpochMs = 0L,
    )

    @Test
    fun `a settled list for the asked-for directory is ready and not refreshing`() {
        val view = LoadViews.plans(PlanList.Ready(here, listOf(row("a"))), here)

        assertEquals(LoadView.Ready(listOf(row("a")), refreshing = false), view)
    }

    @Test
    fun `a refresh over a cache shows the cache and says it is refreshing`() {
        val view = LoadViews.plans(PlanList.Refreshing(here, listOf(row("a"))), here)

        assertEquals(LoadView.Ready(listOf(row("a")), refreshing = true), view)
    }

    @Test
    fun `another directory's settled plans never reach this directory's screen`() {
        val view = LoadViews.plans(PlanList.Ready(elsewhere, listOf(row("a"))), here)

        assertEquals(LoadView.Loading, view)
    }

    @Test
    fun `another directory's failure is not this directory's failure`() {
        val view = LoadViews.plans(PlanList.Failed(elsewhere, "nope"), here)

        assertEquals(LoadView.Loading, view)
    }

    @Test
    fun `a screen with no scope yet draws no answer at all`() {
        val view = LoadViews.plans(PlanList.Ready(here, listOf(row("a"))), dirPath = null)

        assertEquals(LoadView.Loading, view)
    }

    @Test
    fun `a failure for the asked-for directory carries the message the user reads`() {
        val view = LoadViews.plans(PlanList.Failed(here, "the link dropped"), here)

        assertEquals(LoadView.Failed("the link dropped"), view)
    }

    @Test
    fun `idle is loading, because nothing has been asked yet`() {
        assertEquals(LoadView.Loading, LoadViews.plans(PlanList.Idle, here))
        assertEquals(LoadView.Loading, LoadViews.sequences(SequenceList.Idle, here))
        assertEquals(LoadView.Loading, LoadViews.plan(PlanDetail.Idle, "a"))
        assertEquals(LoadView.Loading, LoadViews.sequence(SequenceDetail.Idle, "a"))
        assertEquals(LoadView.Loading, LoadViews.context(ContextDetail.Idle, "a"))
        assertEquals(LoadView.Loading, LoadViews.contexts(ContextList.Idle, "proj"))
        assertEquals(LoadView.Loading, LoadViews.planContexts(PlanContextRefs.Idle, "a"))
        assertEquals(LoadView.Loading, LoadViews.projects(ProjectList.Idle))
    }

    @Test
    fun `a settled detail is keyed on the plan actually open`() {
        val settled = PlanDetail.Ready(plan("a"))

        assertEquals(LoadView.Ready(plan("a"), refreshing = false), LoadViews.plan(settled, "a"))
        assertEquals(LoadView.Loading, LoadViews.plan(settled, "b"))
    }

    @Test
    fun `a plan's context refs belong only to the plan that asked for them`() {
        val refs = listOf(HelmPlanContextRef("ctx", "Coding", "sequence"))
        val settled = PlanContextRefs.Ready("a", refs)

        assertEquals(LoadView.Ready(refs, refreshing = false), LoadViews.planContexts(settled, "a"))
        assertEquals(LoadView.Loading, LoadViews.planContexts(settled, "b"))
    }

    @Test
    fun `a lane list is keyed on its directory like the plans it groups`() {
        val settled = SequenceList.Ready(here, listOf(lane("l")))

        assertEquals(LoadView.Ready(listOf(lane("l")), refreshing = false), LoadViews.sequences(settled, here))
        assertEquals(LoadView.Loading, LoadViews.sequences(settled, elsewhere))
    }

    @Test
    fun `a settled lane detail is keyed on the lane actually open`() {
        val settled = SequenceDetail.Ready(lane("l"))

        assertEquals(LoadView.Ready(lane("l"), refreshing = false), LoadViews.sequence(settled, "l"))
        assertEquals(LoadView.Loading, LoadViews.sequence(settled, "other"))
    }

    @Test
    fun `context nodes are keyed on the project, not the directory`() {
        val settled = ContextList.Ready("proj", listOf(node("n", "proj")))

        assertEquals(LoadView.Ready(listOf(node("n", "proj")), refreshing = false), LoadViews.contexts(settled, "proj"))
        assertEquals(LoadView.Loading, LoadViews.contexts(settled, "other"))
    }

    @Test
    fun `a settled context body is keyed on the node actually open`() {
        val settled = ContextDetail.Ready(node("n", "proj"))

        assertEquals(LoadView.Ready(node("n", "proj"), refreshing = false), LoadViews.context(settled, "n"))
        assertEquals(LoadView.Loading, LoadViews.context(settled, "other"))
    }

    @Test
    fun `the projects are unkeyed, so a refresh still shows what was known`() {
        val cached = listOf(HelmProject("p", "Alpha", here))

        assertEquals(LoadView.Ready(cached, refreshing = true), LoadViews.projects(ProjectList.Refreshing(cached)))
        assertEquals(LoadView.Ready(cached, refreshing = false), LoadViews.projects(ProjectList.Ready(cached)))
        assertEquals(LoadView.Failed("no link"), LoadViews.projects(ProjectList.Failed("no link")))
    }
}
