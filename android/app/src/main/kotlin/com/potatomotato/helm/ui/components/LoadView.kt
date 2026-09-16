package com.potatomotato.helm.ui.components

import com.potatomotato.helm.data.ContextDetail
import com.potatomotato.helm.data.ContextList
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.HelmPlanContextRef
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.data.PlanContextRefs
import com.potatomotato.helm.data.PlanDetail
import com.potatomotato.helm.data.PlanList
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.SequenceDetail
import com.potatomotato.helm.data.SequenceList

/**
 * What a screen needs to know about an answer that is still arriving.
 *
 * THIS IS THE REUSE SEAM. Every repository here keeps its own five-state machine
 * carrying its own scope key (dirPath, projectId, a plan id), and every one of
 * those machines says the same three things to a reader: there is nothing yet,
 * here is data (possibly being re-checked), or here is why there is nothing. A
 * composable given this instead of the repository state knows nothing about
 * WHERE its scope came from — which is what lets one plan list serve both the
 * top-level board and the in-session view of a session's own directory.
 *
 * [Ready.refreshing] rather than a fourth case: a refresh is not a different
 * screen, it is the same rows with a spinner's worth of doubt attached, and
 * making it a case would force every caller to render the cached body twice.
 */
sealed interface LoadView<out T> {

    /** Nothing to show yet, and no reason it will not come. */
    data object Loading : LoadView<Nothing>

    /** [data] is on screen; [refreshing] says a fresh ask is still in flight. */
    data class Ready<out T>(val data: T, val refreshing: Boolean) : LoadView<T>

    /** [message] is what the user reads, verbatim from the repository. */
    data class Failed(val message: String) : LoadView<Nothing>
}

/**
 * LoadViews — repository state, narrowed to what one scope's screen may draw.
 *
 * THE SCOPE CHECK IS THE POINT, not the state mapping. Each repository holds ONE
 * state machine shared by every scope, so the moment a user switches project (or
 * opens a session whose directory differs from the board they were reading) the
 * flow still carries the PREVIOUS scope's answer until the new one lands. Handing
 * that to the screen unchecked would draw one project's plans under another
 * project's name — a wrong answer, which is worse than a slow one. A state whose
 * key is not the asked-for key reads as [LoadView.Loading]: the honest "not yet".
 *
 * Pure Kotlin, no Compose and no Android, because that check has rules in it and
 * rules belong somewhere a JVM test can pin them.
 */
object LoadViews {

    /** A directory's plans, or Loading while the flow still speaks for another. */
    fun plans(state: PlanList, dirPath: String?): LoadView<List<HelmPlanSummary>> = when (state) {
        PlanList.Idle -> LoadView.Loading
        is PlanList.Loading -> LoadView.Loading
        is PlanList.Refreshing -> scoped(state.dirPath, dirPath) { LoadView.Ready(state.cached, true) }
        is PlanList.Ready -> scoped(state.dirPath, dirPath) { LoadView.Ready(state.plans, false) }
        is PlanList.Failed -> scoped(state.dirPath, dirPath) { LoadView.Failed(state.message) }
    }

    /** One plan's detail, keyed on the plan actually open. */
    fun plan(state: PlanDetail, planId: String?): LoadView<HelmPlan> = when (state) {
        PlanDetail.Idle -> LoadView.Loading
        is PlanDetail.Loading -> LoadView.Loading
        is PlanDetail.Refreshing -> scoped(state.planId, planId) { LoadView.Ready(state.cached, true) }
        is PlanDetail.Ready -> scoped(state.plan.id, planId) { LoadView.Ready(state.plan, false) }
        is PlanDetail.Failed -> scoped(state.planId, planId) { LoadView.Failed(state.message) }
    }

    /** One plan's effective context refs, keyed on the plan actually open. */
    fun planContexts(
        state: PlanContextRefs,
        planId: String?,
    ): LoadView<List<HelmPlanContextRef>> = when (state) {
        PlanContextRefs.Idle -> LoadView.Loading
        is PlanContextRefs.Loading -> LoadView.Loading
        is PlanContextRefs.Refreshing -> scoped(state.planId, planId) { LoadView.Ready(state.cached, true) }
        is PlanContextRefs.Ready -> scoped(state.planId, planId) { LoadView.Ready(state.refs, false) }
        is PlanContextRefs.Failed -> scoped(state.planId, planId) { LoadView.Failed(state.message) }
    }

    /** A directory's sequence lanes, keyed on the directory being shown. */
    fun sequences(state: SequenceList, dirPath: String?): LoadView<List<HelmPlanSequence>> = when (state) {
        SequenceList.Idle -> LoadView.Loading
        is SequenceList.Loading -> LoadView.Loading
        is SequenceList.Refreshing -> scoped(state.dirPath, dirPath) { LoadView.Ready(state.cached, true) }
        is SequenceList.Ready -> scoped(state.dirPath, dirPath) { LoadView.Ready(state.sequences, false) }
        is SequenceList.Failed -> scoped(state.dirPath, dirPath) { LoadView.Failed(state.message) }
    }

    /** One lane's detail, keyed on the lane actually open. */
    fun sequence(state: SequenceDetail, sequenceId: String?): LoadView<HelmPlanSequence> = when (state) {
        SequenceDetail.Idle -> LoadView.Loading
        is SequenceDetail.Loading -> LoadView.Loading
        is SequenceDetail.Refreshing -> scoped(state.sequenceId, sequenceId) { LoadView.Ready(state.cached, true) }
        is SequenceDetail.Ready -> scoped(state.sequence.id, sequenceId) { LoadView.Ready(state.sequence, false) }
        is SequenceDetail.Failed -> scoped(state.sequenceId, sequenceId) { LoadView.Failed(state.message) }
    }

    /** The projects. Unkeyed — there is one projects answer per desktop. */
    fun projects(state: ProjectList): LoadView<List<HelmProject>> = when (state) {
        ProjectList.Idle -> LoadView.Loading
        ProjectList.Loading -> LoadView.Loading
        is ProjectList.Refreshing -> LoadView.Ready(state.cached, true)
        is ProjectList.Ready -> LoadView.Ready(state.projects, false)
        is ProjectList.Failed -> LoadView.Failed(state.message)
    }

    /** A project's context nodes, keyed on the project being shown. */
    fun contexts(state: ContextList, projectId: String?): LoadView<List<HelmContext>> = when (state) {
        ContextList.Idle -> LoadView.Loading
        is ContextList.Loading -> LoadView.Loading
        is ContextList.Refreshing -> scoped(state.projectId, projectId) { LoadView.Ready(state.cached, true) }
        is ContextList.Ready -> scoped(state.projectId, projectId) { LoadView.Ready(state.contexts, false) }
        is ContextList.Failed -> scoped(state.projectId, projectId) { LoadView.Failed(state.message) }
    }

    /** One context node read in full, keyed on the node actually open. */
    fun context(state: ContextDetail, contextId: String?): LoadView<HelmContext> = when (state) {
        ContextDetail.Idle -> LoadView.Loading
        is ContextDetail.Loading -> LoadView.Loading
        is ContextDetail.Refreshing -> scoped(state.contextId, contextId) { LoadView.Ready(state.cached, true) }
        is ContextDetail.Ready -> scoped(state.context.id, contextId) { LoadView.Ready(state.context, false) }
        is ContextDetail.Failed -> scoped(state.contextId, contextId) { LoadView.Failed(state.message) }
    }

    /**
     * [view] only when the state's key is the one the screen asked for.
     *
     * A null [asked] is a screen with no scope yet — nothing has been chosen, so
     * there is nothing any answer could correctly be about.
     */
    private inline fun <T> scoped(
        holds: String,
        asked: String?,
        view: () -> LoadView<T>,
    ): LoadView<T> = if (asked != null && holds == asked) view() else LoadView.Loading
}
