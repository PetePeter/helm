package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences

/** Device-local persistence for the expanded tablet's pending-todos pane height. */
internal interface TabletPaneHeightStore {
    fun loadTodoHeightDp(): Float?
    fun saveTodoHeightDp(heightDp: Float)
}

internal class SharedPreferencesTabletPaneHeightStore(context: Context) : TabletPaneHeightStore {
    private val preferences: SharedPreferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun loadTodoHeightDp(): Float? =
        if (preferences.contains(KEY_TODO_HEIGHT_DP)) preferences.getFloat(KEY_TODO_HEIGHT_DP, 0f) else null

    override fun saveTodoHeightDp(heightDp: Float) {
        preferences.edit().putFloat(KEY_TODO_HEIGHT_DP, heightDp).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "tablet-layout"
        const val KEY_TODO_HEIGHT_DP = "todo-pane-height-dp"
    }
}
