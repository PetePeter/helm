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

    /** A project group heading. [count] is the group's size, collapsed or not. */
    data class Header(val label: String, val collapsed: Boolean, val count: Int) : RowEntry

    /** One session row. */
    data class Session(val session: HelmSession) : RowEntry
}

object SessionRows {

    /**
     * Group [HelmSession.projectLabel]-sorted sessions into headers and rows.
     * A collapsed group contributes its header only — the header keeps the
     * group's existence and size on screen.
     */
    fun build(sessions: List<HelmSession>, collapsed: Set<String>): List<RowEntry> {
        val counts = sessions.groupingBy { it.projectLabel }.eachCount()
        val rows = mutableListOf<RowEntry>()
        var lastLabel: String? = null
        for (session in sessions) {
            if (session.projectLabel != lastLabel) {
                lastLabel = session.projectLabel
                rows += RowEntry.Header(
                    label = session.projectLabel,
                    collapsed = session.projectLabel in collapsed,
                    count = counts[session.projectLabel] ?: 0,
                )
            }
            if (session.projectLabel !in collapsed) rows += RowEntry.Session(session)
        }
        return rows
    }

    /** The label set with one label flipped. */
    fun toggle(collapsed: Set<String>, label: String): Set<String> =
        if (label in collapsed) collapsed - label else collapsed + label
}
