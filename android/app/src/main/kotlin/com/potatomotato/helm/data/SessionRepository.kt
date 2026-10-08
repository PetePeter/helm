package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * SessionRepository — the phone's picture of what Helm is running.
 *
 * It is kept current by Helm's session change feed, not by polling: the first
 * `session_list` returns the whole list and a [cursor], Helm then sends one
 * `changes` notice when the list moves, and the fetch that follows asks only
 * for what changed since that cursor. See [applyChanges] and HelmClient.
 *
 * Whole lists are still merged BY ID, and an entry that has not changed keeps
 * the instance it already had. Compose then skips every row a refresh did not
 * actually touch, so a list of thirty sessions where one dot went green
 * recomposes one row.
 *
 * Ordering is imposed here too, so the list cannot flicker when Helm happens to
 * enumerate sessions in a different order between two fetches.
 */
class SessionRepository {
    private val _sessions = MutableStateFlow<List<HelmSession>>(emptyList())
    val sessions: StateFlow<List<HelmSession>> = _sessions.asStateFlow()

    private val _reach = MutableStateFlow(Reach.Never)

    /**
     * Why the list looks the way it does. Owned here because this class already
     * owns the world it describes, and a second holder would be a second truth.
     *
     * A StateFlow of an enum is load-bearing, not incidental: it CONFLATES equal
     * values, so the poll refusing forty times in a row is one state change and
     * one calm screen rather than forty notices. That is the anti-spam property,
     * and it comes from the type rather than from a debounce.
     */
    val reach: StateFlow<Reach> = _reach.asStateFlow()

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
        // An empty snapshot is an ANSWER, and the only thing that earns the
        // right to tell the user no sessions are running.
        _reach.value = Reach.Delivered
    }

    /**
     * Where the held list has got to in Helm's change feed — what the next
     * fetch passes as `since`. Null until a reply names one, which makes that
     * fetch ask for everything.
     */
    var cursor: SessionCursor? = null
        private set

    /**
     * Take one `session_list` answer: the whole list, or only what moved.
     *
     * A delta is merged BY ID over what is held, so the instance-preserving
     * property [applySnapshot] documents holds here for free — an untouched row
     * is not in the reply at all.
     */
    fun applyChanges(changes: SessionChanges) {
        if (changes.full) {
            applySnapshot(changes.sessions)
        } else {
            val gone = changes.removed.toSet()
            val moved = changes.sessions.associateBy { it.id }
            val kept = _sessions.value.filter { it.id !in gone && it.id !in moved }
            _sessions.value = (kept + changes.sessions).sortedWith(ORDER)
            _reach.value = Reach.Delivered
        }
        cursor = changes.cursor
    }

    /**
     * The gate refused. The list is left alone deliberately: losing permission
     * says nothing about sessions the user was already shown.
     */
    fun denied() {
        _reach.value = Reach.Denied
    }

    /** An answer arrived that this app could not read. Never silent, never blamed elsewhere. */
    fun undecodable() {
        _reach.value = Reach.Undecodable
    }

    /**
     * The link went. Whatever we learned about permissions belonged to that
     * link and must not be asserted about the next one.
     */
    fun forget() {
        _reach.value = Reach.Never
    }

    /** The thread for one session, or null once it is gone. */
    fun find(sessionId: String): HelmSession? = _sessions.value.firstOrNull { it.id == sessionId }

    private companion object {
        /**
         * This desktop's own sessions by project, then Remote rows by machine;
         * alphabetical within a group, with the id breaking ties so two
         * identically named sessions never swap places between polls.
         */
        val ORDER: Comparator<HelmSession> =
            compareBy({ it.machineName != null }, { it.groupLabel }, { it.name }, { it.id })
    }
}
