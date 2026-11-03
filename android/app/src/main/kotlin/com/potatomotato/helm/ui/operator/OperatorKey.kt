package com.potatomotato.helm.ui.operator

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The "Call operator" app shortcut (res/xml/shortcuts.xml) and the "Helm - Operator"
 * launcher entry ([CallOperatorActivity]), either of which a hardware key like
 * the Motorola AI key can launch. It carries no target: the operator is
 * resolved from the live session list, so the exported entry can never be
 * pointed at an arbitrary session.
 */
sealed interface OperatorKeyAction {
    data class Dial(val operatorId: String) : OperatorKeyAction
    data object HangUp : OperatorKeyAction
    data object Unavailable : OperatorKeyAction

    companion object {
        /** In Helm, once it is up: the key toggles — any live call ends, else the operator is rung. */
        fun decide(operatorId: String?, liveCallTarget: String?): OperatorKeyAction = when {
            liveCallTarget != null -> HangUp
            operatorId != null -> Dial(operatorId)
            else -> Unavailable
        }
    }
}

/** What a press does before Helm is brought up — the only place the lock screen is weighed. */
sealed interface KeyPress {
    data object HangUp : KeyPress
    data class Open(val overLockScreen: Boolean) : KeyPress
    /** Locked too long: a pocket press must not dial, so the system unlock comes first. */
    data object Unlock : KeyPress

    companion object {
        /** A phone just used — a call just ended, or the screen just went off — may call while locked. */
        const val RECENT_MS = 10 * 60_000L

        fun gate(locked: Boolean, inCall: Boolean, now: Long, callEndedAt: Long?, screenOffAt: Long?): KeyPress {
            fun recent(at: Long?) = at != null && now - at <= RECENT_MS
            return when {
                inCall -> HangUp
                !locked -> Open(overLockScreen = false)
                recent(callEndedAt) || recent(screenOffAt) -> Open(overLockScreen = true)
                else -> Unlock
            }
        }
    }
}

/**
 * A press parked until HelmHome can act on it — cold start has no composition
 * yet — plus the two moments the lock-screen gate reads. All in memory: a
 * process that died forgot them, which only ever falls back to [KeyPress.Unlock].
 */
object OperatorKey {
    /** elapsedRealtime of the last call ending (VoiceCallService). */
    @Volatile
    var callEndedAt: Long? = null

    /** elapsedRealtime of the last screen-off (HelmApp). */
    @Volatile
    var screenOffAt: Long? = null

    /** Set with a press allowed to show over the lock screen; MainActivity reads it. */
    @Volatile
    var overLockScreen: Boolean = false

    private val _pending = MutableStateFlow(false)
    val pending: StateFlow<Boolean> = _pending.asStateFlow()

    fun request(overLockScreen: Boolean = false) {
        this.overLockScreen = overLockScreen
        _pending.value = true
    }

    fun consume(): Boolean = _pending.value.also { _pending.value = false }
}
