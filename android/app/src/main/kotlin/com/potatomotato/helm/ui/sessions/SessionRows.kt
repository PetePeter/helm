package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.data.HelmSession

/**
 * What the sessions list renders, decided before Compose gets involved: the
 * project headers, and which sessions survive a collapsed group.
 *
 * Pure and tested because these are decisions, not layout: a collapsed group
 * that still shows rows, or a header count that disagrees with the rows under
 * it, are failures no screenshot review reliably catches.
 */
sealed interface RowEntry {

    /** A project (or, for Remote rows, machine) group heading. [count] is the group's size, collapsed or not. */
    data class Header(val label: String, val collapsed: Boolean, val count: Int) : RowEntry

    /** One session row. */
    data class Session(val session: HelmSession) : RowEntry
}

object SessionRows {

    /** The neighboring session in list order, or null at either end. */
    fun adjacentSessionId(sessionIds: List<String>, currentSessionId: String, step: Int): String? {
        require(step == -1 || step == 1) { "step must be -1 (previous) or 1 (next)" }
        val index = sessionIds.indexOf(currentSessionId)
        if (index < 0) return null
        return sessionIds.getOrNull(index + step)
    }

    /**
     * Group [HelmSession.groupLabel]-sorted sessions into headers and rows.
     * A collapsed group contributes its header only — the header keeps the
     * group's existence and size on screen.
     */
    fun build(sessions: List<HelmSession>, collapsed: Set<String>): List<RowEntry> {
        val counts = sessions.groupingBy { it.groupLabel }.eachCount()
        val rows = mutableListOf<RowEntry>()
        var lastLabel: String? = null
        for (session in sessions) {
            if (session.groupLabel != lastLabel) {
                lastLabel = session.groupLabel
                rows += RowEntry.Header(
                    label = session.groupLabel,
                    collapsed = session.groupLabel in collapsed,
                    count = counts[session.groupLabel] ?: 0,
                )
            }
            if (session.groupLabel !in collapsed) rows += RowEntry.Session(session)
        }
        return rows
    }

    /** The label set with one label flipped. */
    fun toggle(collapsed: Set<String>, label: String): Set<String> =
        if (label in collapsed) collapsed - label else collapsed + label

    /**
     * The words an unread badge shows, or null when there is no badge.
     *
     * A two-digit count breaks the pill's rhythm and buys nothing: past nine
     * the row only has to say "more than you have read".
     */
    fun unreadBadgeLabel(count: Int): String? = when {
        count <= 0 -> null
        count > UNREAD_BADGE_CAP -> "$UNREAD_BADGE_CAP+"
        else -> count.toString()
    }

    /** The 🔥 pill: subagents this session is waiting on. Null when none. */
    fun subagentBadgeLabel(count: Int): String? = if (count > 0) "🔥$count" else null

    private const val UNREAD_BADGE_CAP = 9
}
