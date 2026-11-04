package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.Capabilities

/** A lifecycle move the plan screen offers (P-0812). */
enum class PlanStateAction { Accept, Reject, Planning, Ready, Done, Reopen }

/**
 * Which state moves a plan's detail screen offers, and the input rules its
 * forms enforce. Pure so the rules test on the JVM.
 *
 * Mirrors what the desktop will ACCEPT rather than what a user might wish:
 * `plan_complete` only completes a coding or review plan, and `plan_set_state`
 * cannot set done, so offering "Done" on a planning plan would be a button that
 * is always refused. Done is terminal until [PlanStateAction.Reopen].
 */
object PlanStateActions {
    /** The desktop's minimum for completion documentation (plan-manager `completeItem`). */
    const val MIN_COMPLETION_CHARS = 10

    fun of(status: PlanStatus): List<PlanStateAction> = when (status) {
        PlanStatus.Suggested -> listOf(PlanStateAction.Accept, PlanStateAction.Reject)
        PlanStatus.Done -> listOf(PlanStateAction.Reopen)
        PlanStatus.Planning -> listOf(PlanStateAction.Ready)
        PlanStatus.Ready -> listOf(PlanStateAction.Planning)
        PlanStatus.Coding, PlanStatus.Review ->
            listOf(PlanStateAction.Planning, PlanStateAction.Ready, PlanStateAction.Done)
        PlanStatus.Blocked, PlanStatus.Unknown -> listOf(PlanStateAction.Planning, PlanStateAction.Ready)
    }

    /** Filter suggestion triage by the current __mobile_tools__ verdict. Unknown is denied. */
    fun available(status: PlanStatus, capabilities: Capabilities): List<PlanStateAction> =
        of(status).filter { action ->
            when (action) {
                PlanStateAction.Accept -> capabilities.permitsTool(ACCEPT_SUGGESTION_TOOL)
                PlanStateAction.Reject -> capabilities.permitsTool(REJECT_SUGGESTION_TOOL)
                else -> true
            }
        }

    /** Whether the completion text would pass the desktop's own check — the confirm greys until it does. */
    fun canComplete(documentation: String): Boolean = documentation.trim().length >= MIN_COMPLETION_CHARS

    /** Every create/edit form needs a title; the desktop would store a blank one as-is. */
    fun canSaveTitle(title: String): Boolean = title.isNotBlank()

    private fun Capabilities.permitsTool(tool: String): Boolean =
        this is Capabilities.Known && tool in tools

    private const val ACCEPT_SUGGESTION_TOOL = "plan_accept_suggestion"
    private const val REJECT_SUGGESTION_TOOL = "plan_reject_suggestion"
}
