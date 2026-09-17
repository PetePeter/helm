package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * A composer draft: its text, and where the caret is in it.
 *
 * The caret travels with the text because dictation lands AT THE CARET — a
 * restored draft that drops the user's cursor at the end of a half-typed line
 * they were editing mid-sentence is restored wrong.
 */
data class Draft(val text: String, val caret: Int)

/**
 * Where the per-session composer drafts live between visits to a thread.
 *
 * PHONE-LOCAL on purpose, exactly like [UnreadStore]: the desktop has no idea
 * the phone was mid-reply, so the draft cannot come from Helm — it belongs to
 * the device the thumb was typing on. A half-typed reply must survive leaving
 * the thread, closing the app, and a process death, but must NEVER follow the
 * user into a different session's thread, which is why every operation is
 * keyed on the session id.
 */
interface DraftStore {
    /** The session's draft, or null when it has none. */
    fun load(sessionId: String): Draft?

    /**
     * Write the draft for one session. An EMPTY draft REMOVES the entry —
     * backspacing to nothing is the user un-drafting, and a stored "" would
     * resurrect an empty caret position over a fresh field.
     */
    fun save(sessionId: String, draft: Draft)

    /** Take the draft away — the send path's "these words are gone now". */
    fun clear(sessionId: String)
}

/** The in-memory default, and the test double for the semantics above. */
class MemoryDraftStore : DraftStore {
    private val drafts = mutableMapOf<String, Draft>()

    override fun load(sessionId: String): Draft? = drafts[sessionId]

    override fun save(sessionId: String, draft: Draft) {
        if (draft.text.isEmpty()) drafts.remove(sessionId) else drafts[sessionId] = draft
    }

    override fun clear(sessionId: String) {
        drafts.remove(sessionId)
    }
}

/**
 * [Draft] ⇄ the string PrefsDraftStore persists, on its own so the corrupt
 * input and caret-clamping decisions pin on the JVM without a device.
 */
object DraftCodec {
    fun encode(draft: Draft): String =
        JSONObject().put(KEY_TEXT, draft.text).put(KEY_CARET, draft.caret).toString()

    /**
     * Null for absent or corrupt input — a draft is a convenience, so reading
     * garbage costs the user a re-type at worst, never a crash. A stored caret
     * beyond the text (an edit raced a write) is clamped, the same coercion
     * [com.potatomotato.helm.ui.chat.DictationInsert] gives a stray selection.
     */
    fun decode(stored: String?): Draft? {
        if (stored == null) return null
        return try {
            val json = JSONObject(stored)
            val text = json.getString(KEY_TEXT)
            Draft(text, json.optInt(KEY_CARET, text.length).coerceIn(0, text.length))
        } catch (_: Exception) {
            null
        }
    }

    private const val KEY_TEXT = "t"
    private const val KEY_CARET = "c"
}

/**
 * [DraftStore] over SharedPreferences, in the clear — one entry per session id,
 * because a draft is only ever read whole and only for the thread on screen.
 * The empty-draft-removes rule lands as a null put, the same trick
 * [PrefsUnreadStore] uses so a cleared value leaves no row behind.
 */
class PrefsDraftStore(context: Context) : DraftStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(sessionId: String): Draft? = DraftCodec.decode(prefs.getString(sessionId, null))

    override fun save(sessionId: String, draft: Draft) {
        val stored = if (draft.text.isEmpty()) null else DraftCodec.encode(draft)
        prefs.edit().putString(sessionId, stored).apply()
    }

    override fun clear(sessionId: String) {
        prefs.edit().remove(sessionId).apply()
    }

    private companion object {
        const val PREFS_NAME = "helm_drafts"
    }
}
