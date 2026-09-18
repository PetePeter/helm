package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences

/**
 * [TransportPreferenceStore] over SharedPreferences, in the clear.
 *
 * Nothing here is a secret — it is a UI choice — so it gets the same plain
 * treatment as [PrefsLanAddressStore] rather than the Keystore wrapping a PSK
 * needs.
 */
class PrefsTransportPreferenceStore(context: Context) : TransportPreferenceStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): TransportPreference =
        TransportPreference.fromStored(prefs.getString(KEY, null))

    override fun save(preference: TransportPreference) {
        prefs.edit().putString(KEY, preference.stored).apply()
    }

    private companion object {
        const val PREFS_NAME = "helm_transport"
        const val KEY = "preference"
    }
}
