package com.potatomotato.helm.voice

import android.content.Context
import android.content.SharedPreferences
import android.view.KeyEvent

internal enum class PttKeyBinding(val keyCode: Int) {
    AltSpace(KeyEvent.KEYCODE_SPACE),
    RightControl(KeyEvent.KEYCODE_CTRL_RIGHT),
    Backtick(KeyEvent.KEYCODE_GRAVE),
}

internal interface PttKeyBindingPreferences {
    fun read(): String?
    fun write(value: String)
}

/** Persists the single hardware key that enters the shared PTT path. */
internal class PttKeyBindingStore(private val preferences: PttKeyBindingPreferences) {
    fun read(): PttKeyBinding = preferences.read()
        ?.let { stored -> PttKeyBinding.entries.firstOrNull { it.name == stored } }
        ?: PttKeyBinding.AltSpace

    fun write(binding: PttKeyBinding) = preferences.write(binding.name)
}

internal fun sharedPttKeyBindingStore(context: Context): PttKeyBindingStore {
    val preferences = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return PttKeyBindingStore(SharedPreferencesPttKeyBindingPreferences(preferences))
}

private class SharedPreferencesPttKeyBindingPreferences(
    private val preferences: SharedPreferences,
) : PttKeyBindingPreferences {
    override fun read(): String? = preferences.getString(BINDING_KEY, null)

    override fun write(value: String) {
        preferences.edit().putString(BINDING_KEY, value).apply()
    }
}

private const val PREFS_NAME = "ptt_key_binding"
private const val BINDING_KEY = "binding"
