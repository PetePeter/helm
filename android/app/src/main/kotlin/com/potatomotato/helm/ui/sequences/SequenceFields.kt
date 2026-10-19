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
 * MEMBERSHIP prefers open human ids, then open internal ids. These are the
 * uncompleted plans the lane displays. If an older desktop sends neither open
 * list, it falls back to all-member human ids and then internal ids. A supplied
 * empty open list means zero open plans rather than missing data.
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
     * Open member ids when the desktop provides them; older desktops fall back
     * to all members. The lane list counts them and the detail screen names them.
     */
    fun memberIds(sequence: HelmPlanSequence): List<String> =
        sequence.openMemberHumanIds
            ?: sequence.openMemberPlanIds
            ?: sequence.memberHumanIds.ifEmpty { sequence.memberPlanIds }

    private const val SEPARATOR = ", "
}
