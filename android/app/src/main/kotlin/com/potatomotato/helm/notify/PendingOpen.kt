package com.potatomotato.helm.notify

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The session a notification tap asked for, waiting to be consumed.
 *
 * Process-scoped for the same reason [com.potatomotato.helm.ble.HelmLink] is: the
 * tap arrives at the Activity, and the screen that can act on it is composed some
 * time later — on a COLD start, before the session list has been polled even once.
 * A request parked here survives that gap; a callback would have nowhere to land.
 *
 * [consume] is what makes it a request rather than a state: the destination is
 * honoured exactly once, so the user can navigate away afterwards and a rotation
 * does not drag them back to the thread they just left.
 */
object PendingOpen {
    private val _sessionId = MutableStateFlow<String?>(null)

    val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

    fun request(sessionId: String?) {
        if (!sessionId.isNullOrBlank()) _sessionId.value = sessionId
    }

    fun consume(): String? = _sessionId.value?.also { _sessionId.value = null }
}
