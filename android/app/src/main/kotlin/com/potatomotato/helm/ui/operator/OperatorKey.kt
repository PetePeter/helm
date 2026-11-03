package com.potatomotato.helm.ui.operator

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The "Call operator" app shortcut (res/xml/shortcuts.xml), which a hardware key
 * like the Motorola AI key can launch. It carries no target: the operator is
 * resolved from the live session list, so the exported entry can never be
 * pointed at an arbitrary session.
 */
sealed interface OperatorKeyAction {
    data class Dial(val operatorId: String) : OperatorKeyAction
    data object HangUp : OperatorKeyAction
    /** Another session's call is live: bring it forward, never drop or retarget it. */
    data class Show(val targetId: String) : OperatorKeyAction
    data object Unavailable : OperatorKeyAction

    companion object {
        fun decide(operatorId: String?, liveCallTarget: String?): OperatorKeyAction = when {
            liveCallTarget != null && liveCallTarget == operatorId -> HangUp
            liveCallTarget != null -> Show(liveCallTarget)
            operatorId != null -> Dial(operatorId)
            else -> Unavailable
        }
    }
}

/** A press parked until HelmHome can act on it — cold start has no composition yet. */
object OperatorKey {
    const val ACTION = "com.potatomotato.helm.action.CALL_OPERATOR"

    private val _pending = MutableStateFlow(false)
    val pending: StateFlow<Boolean> = _pending.asStateFlow()

    fun request() {
        _pending.value = true
    }

    fun consume(): Boolean = _pending.value.also { _pending.value = false }
}
