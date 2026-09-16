package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlan
import com.potatomotato.helm.ui.components.DetailField
import com.potatomotato.helm.ui.components.DetailLabel
import com.potatomotato.helm.ui.components.field
import com.potatomotato.helm.ui.components.flag

/**
 * PlanFields — which of a plan's facts the detail screen has anything to say
 * about, in the order it says them.
 *
 * PURE KOTLIN, no Compose and no Android, for the reason [PlanGrouping] is: the
 * OMISSION RULES are the part with decisions in them. A plan mid-flight has no
 * completion notes, an old plan has no `autoImplement` answer at all, and a
 * screen that renders every field unconditionally shows a column of empty labels
 * that buries the two fields actually carrying something. What gets left out is
 * therefore worth a test, and a test cannot reach a `@Composable`.
 *
 * ORDER IS THE READING ORDER, not the wire order: what the plan IS, then what it
 * is doing, then how it ends, then the machinery. The title and status are NOT
 * here — they are the screen's heading and its pill, not entries in a list.
 */
object PlanFields {

    fun of(plan: HelmPlan): List<DetailField> = listOfNotNull(
        field(DetailLabel.PlanId, plan.humanId),
        field(DetailLabel.Description, plan.description),
        // The state note is the live "why is it like this"; it outranks the
        // completion prose, which only matters once the plan is finished.
        field(DetailLabel.StateNote, plan.stateInfo),
        field(DetailLabel.CompletionNotes, plan.completionNotes),
        field(DetailLabel.Type, plan.type),
        flag(DetailLabel.AutoImplement, plan.autoImplement),
        flag(DetailLabel.CompletionRecap, plan.completionRecap),
        // Last, because on the in-session surface it is the directory the user
        // is already standing in — true, and rarely news.
        field(DetailLabel.Directory, plan.dirPath),
    )
}
