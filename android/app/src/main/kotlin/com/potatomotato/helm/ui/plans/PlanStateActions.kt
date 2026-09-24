package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.PlanStatus

/** A lifecycle move the plan screen offers (P-0812). */
enum class PlanStateAction { Planning, Ready, Done, Reopen }

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
        PlanStatus.Done -> listOf(PlanStateAction.Reopen)
        PlanStatus.Planning -> listOf(PlanStateAction.Ready)
        PlanStatus.Ready -> listOf(PlanStateAction.Planning)
        PlanStatus.Coding, PlanStatus.Review ->
            listOf(PlanStateAction.Planning, PlanStateAction.Ready, PlanStateAction.Done)
        PlanStatus.Blocked, PlanStatus.Unknown -> listOf(PlanStateAction.Planning, PlanStateAction.Ready)
    }

    /** Whether the completion text would pass the desktop's own check — the confirm greys until it does. */
    fun canComplete(documentation: String): Boolean = documentation.trim().length >= MIN_COMPLETION_CHARS

    /** Every create/edit form needs a title; the desktop would store a blank one as-is. */
    fun canSaveTitle(title: String): Boolean = title.isNotBlank()
}
