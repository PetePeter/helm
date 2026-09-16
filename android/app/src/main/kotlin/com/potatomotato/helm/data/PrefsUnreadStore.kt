package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * [UnreadStore] over SharedPreferences, in the clear — one JSON object holding
 * every count, because the map is tiny and always read whole.
 *
 * Corrupt preferences are read as "nothing unread", which is the safe reading:
 * a badge is a nudge, never a promise, so a lost count costs a missed nudge
 * and nothing else. The same reading as [PrefsLanAddressStore].
 */
class PrefsUnreadStore(context: Context) : UnreadStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun counts(): Map<String, Int> {
        val stored = prefs.getString(KEY_COUNTS, null) ?: return emptyMap()
        return try {
            val json = JSONObject(stored)
            buildMap {
                for (key in json.keys()) {
                    val count = json.optInt(key, 0)
                    if (count > 0) put(key, count)
                }
            }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    override fun setCount(sessionId: String, count: Int) {
        // Read-modify-write over the one JSON object: a session being marked
        // read must not erase what arrived for the others.
        val next = JSONObject(counts())
        if (count <= 0) next.remove(sessionId) else next.put(sessionId, count)
        prefs.edit().putString(KEY_COUNTS, next.toString()).apply()
    }

    private companion object {
        const val PREFS_NAME = "helm_unread"
        const val KEY_COUNTS = "counts"
    }
}
