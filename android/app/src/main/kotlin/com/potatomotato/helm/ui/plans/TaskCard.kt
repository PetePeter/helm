package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanTask

/** When an operator task is checked next. [NoTimer] is shown on purpose: a task nobody checks is a dropped ask. */
sealed interface NextCheck {
    data object NoTimer : NextCheck
    data object DueNow : NextCheck
    data class At(val epochMs: Long) : NextCheck
}

/** The rules behind an operator task's row line. Pure Kotlin so a JVM test can pin them. */
object TaskCard {

    fun nextCheck(task: HelmPlanTask, nowEpochMs: Long): NextCheck {
        val at = task.nextCheckAtEpochMs ?: return NextCheck.NoTimer
        return if (at <= nowEpochMs) NextCheck.DueNow else NextCheck.At(at)
    }

    /** The builder's live name, else its id — a gone session is still worth naming. */
    fun builder(task: HelmPlanTask): String? = task.builderName ?: task.builderSessionId
}
