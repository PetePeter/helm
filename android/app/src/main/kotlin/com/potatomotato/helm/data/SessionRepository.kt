package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * SessionRepository — the phone's picture of what Helm is running.
 *
 * Snapshots arrive by POLLING `session_list` while the list screen is visible.
 * That is deliberate, not a shortcut: the envelope has exactly four record types
 * and only `chat` travels Helm-to-phone unprompted, so there is no push channel
 * to subscribe to and adding one would be a wire break. The desktop's per-device
 * rate limit was sized for exactly this (60/min, "a screen open on the sessions
 * list refreshes far more often than a peer AI issues tool calls").
 *
 * What makes the updates INCREMENTAL is here rather than on the wire: a snapshot
 * is merged BY ID, and an entry that has not changed keeps the instance it
 * already had. Compose then skips every row the poll did not actually touch, so
 * a list of thirty sessions where one dot went green recomposes one row.
 *
 * Ordering is imposed here too, so the list cannot flicker when Helm happens to
 * enumerate sessions in a different order between two polls.
 */
class SessionRepository {
    private val _sessions = MutableStateFlow<List<HelmSession>>(emptyList())
    val sessions: StateFlow<List<HelmSession>> = _sessions.asStateFlow()

    /**
     * Replace the world with [incoming], preserving untouched entries.
     *
     * A snapshot is authoritative: a session missing from it has gone, so it goes
     * here too. There is no tombstone and no grace period — the alternative is a
     * list that accumulates sessions the user closed hours ago.
     */
    fun applySnapshot(incoming: List<HelmSession>) {
        val known = _sessions.value.associateBy { it.id }
        _sessions.value = incoming
            .map { fresh -> known[fresh.id]?.takeIf { it == fresh } ?: fresh }
            .sortedWith(ORDER)
    }

    /** The thread for one session, or null once it is gone. */
    fun find(sessionId: String): HelmSession? = _sessions.value.firstOrNull { it.id == sessionId }

    private companion object {
        /**
         * Grouped by project, alphabetical within it, with the id breaking ties
         * so two identically named sessions never swap places between polls.
         */
        val ORDER: Comparator<HelmSession> = compareBy({ it.projectLabel }, { it.name }, { it.id })
    }
}
