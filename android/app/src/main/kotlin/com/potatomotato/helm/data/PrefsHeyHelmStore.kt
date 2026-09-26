package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences

/** Where the "Hey Helm" switch is kept. */
interface HeyHelmStore {
    fun load(): Boolean
    fun save(enabled: Boolean)
}

/**
 * [HeyHelmStore] over SharedPreferences, in the clear — a UI choice, the same
 * plain treatment as [PrefsTransportPreferenceStore]. Absent reads as OFF: a
 * background microphone is only ever something the user turned on.
 */
class PrefsHeyHelmStore(context: Context) : HeyHelmStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): Boolean {
        // Once per install: builds that shipped the switch on by default left
        // it on for users who never chose it; reset them to off.
        if (!prefs.getBoolean(KEY_RESET_OFF, false)) {
            prefs.edit().putBoolean(KEY, false).putBoolean(KEY_RESET_OFF, true).apply()
            return false
        }
        return prefs.getBoolean(KEY, false)
    }

    override fun save(enabled: Boolean) {
        prefs.edit().putBoolean(KEY, enabled).apply()
    }

    private companion object {
        const val PREFS_NAME = "helm_voice"
        const val KEY = "hey_helm"
        const val KEY_RESET_OFF = "hey_helm_reset_off_v1"
    }
}
