package com.potatomotato.helm.data

/**
 * Where the per-session unread counts live between app launches.
 *
 * PHONE-LOCAL on purpose: the desktop has no idea what the phone has shown,
 * so read state cannot come from Helm — it is derived here, on the device the
 * reading happens on. And it must persist, because a badge that forgets
 * itself when the process dies lies in exactly the case it exists for.
 *
 * An interface so the counting logic in [ChatRepository] is testable without
 * a device, the same way [LanAddressStore] makes the dialling logic testable.
 */
interface UnreadStore {
    /** Every stored count. Empty when nothing is unread or nothing is known. */
    fun counts(): Map<String, Int>

    /**
     * Write the whole value for one session. Zero REMOVES the entry — a
     * read thread must not linger as a permanent `0` row in the store.
     */
    fun setCount(sessionId: String, count: Int)
}

/**
 * The in-memory default, used until the app has a Context to attach the real
 * store with — the same late attachment as the notification settings.
 */
class MemoryUnreadStore : UnreadStore {
    private val counts = mutableMapOf<String, Int>()

    override fun counts(): Map<String, Int> = counts.toMap()

    override fun setCount(sessionId: String, count: Int) {
        if (count <= 0) counts.remove(sessionId) else counts[sessionId] = count
    }
}
