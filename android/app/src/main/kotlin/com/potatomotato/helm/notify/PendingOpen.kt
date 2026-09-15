package com.potatomotato.helm.notify

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where a notification tap asked to go, waiting to be consumed.
 *
 * Process-scoped for the same reason [com.potatomotato.helm.ble.HelmLink] is: the
 * tap arrives at the Activity, and the screen that can act on it is composed some
 * time later — on a COLD start, before the session list has been polled even once.
 * A request parked here survives that gap; a callback would have nowhere to land.
 *
 * [consume] is what makes it a request rather than a state: the destination is
 * honoured exactly once, so the user can navigate away afterwards and a rotation
 * does not drag them back to the screen they just left.
 */
object PendingOpen {

    /**
     * A session, and which of its screens the tap wants. A session row lands in
     * the thread; an ARTIFACT row lands in that session's artifacts list, which
     * is where its artifacts live.
     */
    data class Target(val sessionId: String, val artifacts: Boolean)

    private val _target = MutableStateFlow<Target?>(null)

    val target: StateFlow<Target?> = _target.asStateFlow()

    fun request(sessionId: String?, artifacts: Boolean = false) {
        if (!sessionId.isNullOrBlank()) _target.value = Target(sessionId, artifacts)
    }

    fun consume(): Target? = _target.value?.also { _target.value = null }
}
