package com.potatomotato.helm.link

import com.potatomotato.helm.data.ContextRepository
import com.potatomotato.helm.data.PlanRepository
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.PlanWriteKind
import com.potatomotato.helm.data.PlanWrites
import com.potatomotato.helm.data.SequenceRepository
import com.potatomotato.helm.wire.JsonNull


class PlanClient internal constructor(
    private val core: HelmClient,
    val state: PlanRepository,
    val sequences: SequenceRepository,
    val writes: PlanWrites,
    val contexts: ContextRepository,
) {
    /**
     * The plans of one directory as BOARD ROWS — `plan_summary`, never the
     * full-record list. The summary carries status, ids, title and edges and
     * leaves every description behind, which is what keeps the answer small
     * enough for this link to finish delivering it. The prose arrives one plan
     * at a time from [readPlan] when the reader opens one.
     *
     * The writes (P-0812) live further down and refresh this board on success.
     *
     * ACTIVE IS FIXED, not a parameter: a finished plan is noise on a phone, and
     * asking for all of them is what cost the link the reply in the first place.
     */
    fun refreshPlans(dirPath: String): Boolean {
        state.listRequested(dirPath)
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "filter" to HelmClient.FILTER_ACTIVE)
        return core.call(HelmClient.METHOD_PLAN_SUMMARY, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!state.listArrived(dirPath, outcome.result)) {
                        state.listFailed(dirPath, HelmClient.UNREADABLE_PLANS)
                    }
                is HelmClient.Outcome.Failed -> state.listFailed(dirPath, outcome.message)
            }
        }
    }

    /**
     * One plan in full. The id rides as `uuid`, which is the only form the
     * desktop's `plan_get` takes — a P-00xx humanId would be refused, and the
     * board already holds the UUID for every row it drew.
     */
    fun readPlan(planId: String): Boolean {
        state.detailRequested(planId)
        return core.call(HelmClient.METHOD_PLAN_GET, linkedMapOf("uuid" to planId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!state.detailArrived(planId, outcome.result)) {
                        state.detailFailed(planId, HelmClient.UNREADABLE_PLAN)
                    }
                is HelmClient.Outcome.Failed -> state.detailFailed(planId, outcome.message)
            }
        }
    }

    /**
     * One plan's effective context refs — its own bindings merged with those
     * inherited from its sequence. Refs only: the bodies are a `context_get`
     * away, fetched when the reader opens one, which is why this answer stays
     * small enough to pull on every visit.
     */
    fun refreshPlanContexts(planId: String): Boolean {
        state.contextRefsRequested(planId)
        return core.call(HelmClient.METHOD_PLAN_CONTEXT_LIST, linkedMapOf("planId" to planId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!state.contextRefsArrived(planId, outcome.result)) {
                        state.contextRefsFailed(planId, HelmClient.UNREADABLE_PLAN_CONTEXTS)
                    }
                is HelmClient.Outcome.Failed -> state.contextRefsFailed(planId, outcome.message)
            }
        }
    }

    /**
     * The sequence lanes of one directory, including the member plan ids the
     * desktop computes per answer. `sequence_list` also accepts a `planId`; only
     * the directory form is sent, because the board groups a whole directory and
     * asking per plan would be one call per row.
     */
    fun refreshSequences(dirPath: String): Boolean {
        sequences.listRequested(dirPath)
        return core.call(HelmClient.METHOD_SEQUENCE_LIST, linkedMapOf("dirPath" to dirPath)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!sequences.listArrived(dirPath, outcome.result)) {
                        sequences.listFailed(dirPath, HelmClient.UNREADABLE_SEQUENCES)
                    }
                is HelmClient.Outcome.Failed -> sequences.listFailed(dirPath, outcome.message)
            }
        }
    }

    /** One sequence lane in full. The id rides as `id`, as `sequence_get` takes it. */
    fun readSequence(sequenceId: String): Boolean {
        sequences.detailRequested(sequenceId)
        return core.call(HelmClient.METHOD_SEQUENCE_GET, linkedMapOf("id" to sequenceId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!sequences.detailArrived(sequenceId, outcome.result)) {
                        sequences.detailFailed(sequenceId, HelmClient.UNREADABLE_SEQUENCE)
                    }
                is HelmClient.Outcome.Failed -> sequences.detailFailed(sequenceId, outcome.message)
            }
        }
    }

    // ------------------------------------------------- plan and sequence writes (P-0812)
    //
    // Every write follows ONE rule: the desktop's answer is only ever a verdict,
    // never data this app parses into a cache. Success re-pulls the small
    // summary/list answers the screens already read; failure touches nothing but
    // [planWrites], so a refused or dropped write leaves every cache as it was.
    // None of these tools answers with more than one record, so none risks the
    // oversized reply that once broke the link.

    /** A new plan in [dirPath]. `type` is omitted when unset — the desktop treats it as optional. */
    fun createPlan(dirPath: String, title: String, description: String, type: String?, autoImplement: Boolean): Boolean {
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "title" to title.trim(), "description" to description)
        if (!type.isNullOrBlank()) params["type"] = type
        params["autoImplement"] = autoImplement
        return write(PlanWriteKind.CreatePlan, HelmClient.METHOD_PLAN_CREATE, params) { refreshBoard(dirPath) }
    }

    /** Title and description only; the other plan_update fields stay the desktop's. */
    fun updatePlan(dirPath: String, planId: String, title: String, description: String): Boolean =
        write(
            PlanWriteKind.UpdatePlan,
            HelmClient.METHOD_PLAN_UPDATE,
            linkedMapOf("uuid" to planId, "title" to title.trim(), "description" to description),
        ) { refreshPlanAndBoard(dirPath, planId) }

    /** Planning/ready and the other non-terminal states. Done is [completePlan]; undone is [reopenPlan]. */
    fun setPlanState(dirPath: String, planId: String, status: PlanStatus): Boolean =
        write(
            PlanWriteKind.SetState,
            HelmClient.METHOD_PLAN_SET_STATE,
            linkedMapOf("uuid" to planId, "status" to status.wire),
        ) { refreshPlanAndBoard(dirPath, planId) }

    fun acceptPlanSuggestion(dirPath: String, planId: String): Boolean =
        write(PlanWriteKind.AcceptSuggestion, HelmClient.METHOD_PLAN_ACCEPT_SUGGESTION, linkedMapOf("uuid" to planId)) {
            refreshPlanAndBoard(dirPath, planId)
        }

    fun rejectPlanSuggestion(dirPath: String, planId: String): Boolean =
        write(PlanWriteKind.RejectSuggestion, HelmClient.METHOD_PLAN_REJECT_SUGGESTION, linkedMapOf("uuid" to planId)) {
            state.planDeleted(planId)
            refreshBoard(dirPath)
        }

    /**
     * Mark done. The desktop demands [documentation] (10+ chars) and only
     * completes a coding/review plan; its refusal text is shown as-is rather
     * than second-guessed here.
     */
    fun completePlan(dirPath: String, planId: String, documentation: String): Boolean =
        write(
            PlanWriteKind.Complete,
            HelmClient.METHOD_PLAN_COMPLETE,
            linkedMapOf("uuid" to planId, "documentation" to documentation.trim()),
        ) { refreshPlanAndBoard(dirPath, planId) }

    fun reopenPlan(dirPath: String, planId: String): Boolean =
        write(PlanWriteKind.Reopen, HelmClient.METHOD_PLAN_REOPEN, linkedMapOf("uuid" to planId)) {
            refreshPlanAndBoard(dirPath, planId)
        }

    /** One plan. The screen confirms first; success purges it at once rather than waiting for the list. */
    fun deletePlan(dirPath: String, planId: String): Boolean =
        write(PlanWriteKind.DeletePlan, HelmClient.METHOD_PLAN_DELETE, linkedMapOf("uuid" to planId)) {
            state.planDeleted(planId)
            refreshBoard(dirPath)
        }

    /** Put a plan in a lane, or take it out of any lane with a null [sequenceId]. */
    fun assignSequence(dirPath: String, planId: String, sequenceId: String?): Boolean =
        write(
            PlanWriteKind.AssignSequence,
            HelmClient.METHOD_SEQUENCE_ASSIGN,
            linkedMapOf<String, Any>("planId" to planId, "sequenceId" to (sequenceId ?: JsonNull)),
        ) { refreshPlanAndBoard(dirPath, planId) }

    fun createSequence(dirPath: String, title: String, missionStatement: String): Boolean {
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "title" to title.trim())
        if (missionStatement.isNotBlank()) params["missionStatement"] = missionStatement
        return write(PlanWriteKind.CreateSequence, HelmClient.METHOD_SEQUENCE_CREATE, params) { refreshLanes(dirPath) }
    }

    /** Title and mission only; sharedMemory is legacy and order belongs to the desktop canvas. */
    fun updateSequence(dirPath: String, sequenceId: String, title: String, missionStatement: String): Boolean =
        write(
            PlanWriteKind.UpdateSequence,
            HelmClient.METHOD_SEQUENCE_UPDATE,
            linkedMapOf("id" to sequenceId, "title" to title.trim(), "missionStatement" to missionStatement),
        ) {
            readSequence(sequenceId)
            refreshLanes(dirPath)
        }

    fun deleteSequence(dirPath: String, sequenceId: String): Boolean =
        write(PlanWriteKind.DeleteSequence, HelmClient.METHOD_SEQUENCE_DELETE, linkedMapOf("id" to sequenceId)) {
            sequences.sequenceDeleted(sequenceId)
            // Members lose their lane on the desktop; the board must regroup.
            refreshBoard(dirPath)
            refreshCleanupCounts(dirPath)
        }

    /** The counts the Sequences tab shows before "Clear unused" is offered. Read-only. */
    fun refreshCleanupCounts(dirPath: String): Boolean {
        sequences.cleanupRequested(dirPath)
        return core.call(HelmClient.METHOD_PLAN_CLEANUP_COUNTS, linkedMapOf("dirPath" to dirPath)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!sequences.cleanupArrived(dirPath, outcome.result)) {
                        sequences.cleanupFailed(dirPath, HelmClient.UNREADABLE_CLEANUP)
                    }
                is HelmClient.Outcome.Failed -> sequences.cleanupFailed(dirPath, outcome.message)
            }
        }
    }

    /**
     * The desktop's "Clear unused", in the desktop's ORDER: done plans, then
     * empty sequences — deleting either releases context bindings, which is
     * what makes those contexts unreferenced — then unreferenced contexts.
     * Each step only runs if the one before succeeded; any failure is the one
     * verdict the user reads.
     */
    fun clearUnused(dirPath: String): Boolean {
        writes.started(PlanWriteKind.ClearUnused)
        return clearStep(HelmClient.METHOD_PLAN_CLEAR_COMPLETED, dirPath) {
            clearStep(HelmClient.METHOD_SEQUENCE_CLEAR_EMPTY, dirPath) { clearUnreferencedContexts(dirPath) }
        }
    }

    /** One non-final [clearUnused] step: [next] runs only on success. */
    private fun clearStep(method: String, dirPath: String, next: () -> Unit): Boolean =
        core.call(method, linkedMapOf("dirPath" to dirPath)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Failed -> writes.failed(PlanWriteKind.ClearUnused, outcome.message)
                is HelmClient.Outcome.Ok -> next()
            }
        }

    /** The last [clearUnused] step; only ever run after the plans and sequences are gone. */
    private fun clearUnreferencedContexts(dirPath: String) {
        refreshSequences(dirPath)
        core.call(HelmClient.METHOD_CONTEXT_CLEAR_UNREFERENCED, linkedMapOf("dirPath" to dirPath)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> writes.succeeded(PlanWriteKind.ClearUnused)
                is HelmClient.Outcome.Failed -> writes.failed(PlanWriteKind.ClearUnused, outcome.message)
            }
            refreshCleanupCounts(dirPath)
        }
    }

    /** One write: raise in-flight, send, and on the verdict either refresh or record the failure. */
    private fun write(
        kind: PlanWriteKind,
        method: String,
        params: Map<String, Any>,
        onSuccess: () -> Unit,
    ): Boolean {
        writes.started(kind)
        return core.call(method, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    writes.succeeded(kind)
                    onSuccess()
                }
                is HelmClient.Outcome.Failed -> writes.failed(kind, outcome.message)
            }
        }
    }

    private fun refreshBoard(dirPath: String) {
        refreshPlans(dirPath)
        refreshSequences(dirPath)
    }

    private fun refreshPlanAndBoard(dirPath: String, planId: String) {
        readPlan(planId)
        refreshBoard(dirPath)
    }

    /** Lanes changed: the list and the cleanup counts both describe them. */
    private fun refreshLanes(dirPath: String) {
        refreshSequences(dirPath)
        refreshCleanupCounts(dirPath)
    }

    /** The context nodes of one project, bodies included — the desktop's list carries them. */
    fun refreshContexts(projectId: String): Boolean {
        contexts.listRequested(projectId)
        return core.call(HelmClient.METHOD_CONTEXT_LIST, linkedMapOf("projectId" to projectId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!contexts.listArrived(projectId, outcome.result)) {
                        contexts.listFailed(projectId, HelmClient.UNREADABLE_CONTEXTS)
                    }
                is HelmClient.Outcome.Failed -> contexts.listFailed(projectId, outcome.message)
            }
        }
    }

    /**
     * One context node in full. Asked for even though the list carries content,
     * because a ref from `plan_context_list` names a node the project list may
     * not have been pulled for — a ref is an id, not a row.
     */
    fun readContext(contextId: String): Boolean {
        contexts.detailRequested(contextId)
        return core.call(HelmClient.METHOD_CONTEXT_GET, linkedMapOf("id" to contextId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!contexts.detailArrived(contextId, outcome.result)) {
                        contexts.detailFailed(contextId, HelmClient.UNREADABLE_CONTEXT)
                    }
                is HelmClient.Outcome.Failed -> contexts.detailFailed(contextId, outcome.message)
            }
        }
    }
}
