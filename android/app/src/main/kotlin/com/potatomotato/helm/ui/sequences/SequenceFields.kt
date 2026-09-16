package com.potatomotato.helm.ui.sequences

import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.ui.components.DetailField
import com.potatomotato.helm.ui.components.DetailLabel
import com.potatomotato.helm.ui.components.field

/**
 * SequenceFields — which of a lane's facts its detail screen has anything to say.
 *
 * Pure Kotlin for the same reason [com.potatomotato.helm.ui.plans.PlanFields] is:
 * the omission rules are the decisions, and a JVM test can pin them.
 *
 * TWO RULES BEYOND "SKIP THE BLANKS":
 *
 * The ORDER is always shown, even when it is 0. Unlike prose, zero is not the
 * absence of an order — it is the first lane, and a board that hides the number
 * for exactly the top lane is a board whose ordering looks arbitrary.
 *
 * MEMBERSHIP prefers the human ids and falls back to the internal ones. The
 * desktop computes both per answer; P-0041 is the name the user has seen on the
 * plan board, and a column of UUIDs is technically the same fact said uselessly.
 * A lane that answered neither says nothing rather than "0 plans" — the member
 * lists are the one part of the wire shape a future desktop could stop sending,
 * and silence is the honest reading of "not answered".
 */
object SequenceFields {

    fun of(sequence: HelmPlanSequence): List<DetailField> = listOfNotNull(
        field(DetailLabel.Order, sequence.order.toString()),
        field(DetailLabel.Mission, sequence.missionStatement),
        field(DetailLabel.SharedMemory, sequence.sharedMemory),
        field(DetailLabel.Members, members(sequence)),
        field(DetailLabel.Contexts, sequence.contextIds.joinToString(SEPARATOR)),
        field(DetailLabel.Directory, sequence.dirPath),
    )

    /** The member plans, named the way the user has already seen them named. */
    fun members(sequence: HelmPlanSequence): String = memberIds(sequence).joinToString(SEPARATOR)

    /**
     * The member ids themselves — human where the desktop answered them, internal
     * otherwise. The lane list counts them; the detail screen names them. One
     * preference rule, so the count and the list can never disagree about which
     * plans a lane holds.
     */
    fun memberIds(sequence: HelmPlanSequence): List<String> =
        sequence.memberHumanIds.ifEmpty { sequence.memberPlanIds }

    private const val SEPARATOR = ", "
}
