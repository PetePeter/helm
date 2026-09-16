package com.potatomotato.helm.ui.plans

import androidx.compose.ui.graphics.Color
import com.potatomotato.helm.R
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.ui.theme.HelmColors

/** The word a reader uses for a lifecycle state, kept out of the composables. */
internal val PlanStatus.labelRes: Int
    get() = when (this) {
        PlanStatus.Planning -> R.string.plan_status_planning
        PlanStatus.Ready -> R.string.plan_status_ready
        PlanStatus.Coding -> R.string.plan_status_coding
        PlanStatus.Review -> R.string.plan_status_review
        PlanStatus.Blocked -> R.string.plan_status_blocked
        PlanStatus.Done -> R.string.plan_status_done
        PlanStatus.Unknown -> R.string.plan_status_unknown
    }

/**
 * The status pill's colour, borrowed from the palette that already exists rather
 * than grown per status.
 *
 * NO NEW TOKENS ON PURPOSE. A plan's lifecycle means the same things a session's
 * activity means — something is running, something is waiting, something has
 * stopped — so it reuses those colours and stays legible to a user who has
 * already learnt the dots. Coding is [HelmColors.State.Active] because it IS
 * work in progress; Blocked is [HelmColors.Danger] because it is the one state
 * that wants the user. An unknown status gets [HelmColors.Faint]: no claim.
 */
internal val PlanStatus.pillColor: Color
    get() = when (this) {
        PlanStatus.Planning -> HelmColors.Dim
        PlanStatus.Ready -> HelmColors.State.Waiting
        PlanStatus.Coding -> HelmColors.State.Active
        PlanStatus.Review -> HelmColors.State.Flash
        PlanStatus.Blocked -> HelmColors.Danger
        PlanStatus.Done -> HelmColors.State.Idle
        PlanStatus.Unknown -> HelmColors.Faint
    }
