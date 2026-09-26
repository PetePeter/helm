package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The live "Hey Helm" switch, process-wide — the same shape as
 * [TransportPreferences], because the switch (in the UI) and the thing that
 * obeys it (VoiceCallService) have no other path between them.
 *
 * Unbound reads as OFF: a wiring mistake must never open a background mic.
 */
object HeyHelmSetting {
    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private var store: HeyHelmStore? = null

    /** Attach persistence and adopt what was stored. Idempotent. */
    fun bind(store: HeyHelmStore) {
        this.store = store
        _enabled.value = store.load()
    }

    fun set(enabled: Boolean) {
        if (_enabled.value == enabled) return
        store?.save(enabled)
        _enabled.value = enabled
    }
}
