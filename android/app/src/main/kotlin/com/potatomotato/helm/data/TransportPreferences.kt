package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The live transport choice, process-wide.
 *
 * A singleton for the same reason `HelmLink` is one: there is exactly one pair
 * of radios, and the two things that must obey this setting — the Bluetooth
 * foreground service and the LAN dialler — are in different objects with no
 * path between them. A flow here is the path.
 *
 * [bind] is called once, late, when a Context exists; until then the value is
 * [TransportPreference.Auto], which is also what an unbound build behaves as.
 * That default matters: a wiring mistake must leave both radios working, never
 * silently disable one.
 */
object TransportPreferences {
    private val _preference = MutableStateFlow(TransportPreference.Auto)

    /** What the user chose. Collected by whoever owns a radio. */
    val preference: StateFlow<TransportPreference> = _preference.asStateFlow()

    private var store: TransportPreferenceStore? = null

    /** Attach persistence and adopt what was stored. Idempotent. */
    fun bind(store: TransportPreferenceStore) {
        this.store = store
        _preference.value = store.load()
    }

    /** Record a choice. Writing before [bind] still takes effect for this run. */
    fun set(preference: TransportPreference) {
        if (_preference.value == preference) return
        store?.save(preference)
        _preference.value = preference
    }
}
