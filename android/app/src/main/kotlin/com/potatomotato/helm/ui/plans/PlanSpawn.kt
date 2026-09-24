package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSummary

/**
 * A spawn aimed at ONE plan — what the plan row's terminal action hands the
 * spawn form.
 *
 * [dirPath] is the directory that loaded the board, never another: a plan
 * belongs to its project, and a session anywhere else could not read it.
 *
 * [prompt] asks the new CLI to READ, not to work. It deliberately says not to
 * claim — a claim moves a Ready plan to Coding, and nothing the user did yet
 * says work has started. The title stays out of it: the prompt travels as
 * sequence syntax, where a title's `{Enter}` would become a keystroke.
 */
data class PlanSpawn(val dirPath: String, val name: String, val prompt: String) {
    companion object {
        fun of(plan: HelmPlanSummary, dirPath: String): PlanSpawn {
            val humanId = plan.humanId?.takeIf { it.isNotBlank() }
            val reference = humanId?.let { "$it (uuid ${plan.id})" } ?: "uuid ${plan.id}"
            return PlanSpawn(
                dirPath = dirPath,
                name = listOfNotNull(humanId, plan.title.trim().ifEmpty { null }).joinToString(" "),
                prompt = "The user started this session from the Helm phone app for plan $reference. " +
                    "Call plan_get for it, then plan_context_list, and context_get only the context bodies " +
                    "that matter to it. Do not call session_plan_claim, do not change the plan, and do not " +
                    "start implementing. Reply with chat_send: a short confirmation of what the plan asks " +
                    "for, then wait for the user's next instruction.",
            )
        }
    }
}
