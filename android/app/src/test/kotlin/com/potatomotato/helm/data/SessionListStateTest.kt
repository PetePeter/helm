package com.potatomotato.helm.data

import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The whole point of this screen's state: an empty list must only ever mean
 * "you have no sessions". Every other reason the list is empty is a different
 * sentence, and each rung of the ordering is pinned here.
 */
class SessionListStateTest {

    private val session = HelmSession(
        id = "s1",
        name = "one",
        projectPath = "x:/proj",
        cliType = "claudecode",
        cliTypeName = "Claude Code",
        activity = SessionState.Idle,
    )

    @Test
    fun `a held list is shown when the world was delivered`() {
        assertEquals(
            SessionListState.Populated,
            sessionListState(LinkState.Linked, listOf(session), Reach.Delivered),
        )
    }

    @Test
    fun `a denial does not blank a list we already hold`() {
        // Stale data beats a lie. Losing permission tells us nothing about the
        // sessions we were already shown.
        assertEquals(
            SessionListState.Populated,
            sessionListState(LinkState.Linked, listOf(session), Reach.Denied),
        )
    }

    @Test
    fun `a link drop does not blank a list we already hold`() {
        // The user's link churns constantly. If a drop emptied the list the
        // phone would flicker blank every time the radio hiccupped.
        for (state in LinkState.entries.filter { it != LinkState.Linked }) {
            for (reach in Reach.entries) {
                assertEquals(
                    "$state / $reach must keep the held list",
                    SessionListState.Populated,
                    sessionListState(state, listOf(session), reach),
                )
            }
        }
    }

    @Test
    fun `no link outranks every reason we might have learned while linked`() {
        // "We could not ask" must not render as "you may not" — gotcha 31 one
        // layer up. With the link down, nothing we learned is known to be current.
        for (state in LinkState.entries.filter { it != LinkState.Linked }) {
            for (reach in Reach.entries) {
                assertEquals(
                    "$state / $reach must read as no link",
                    SessionListState.NoLink,
                    sessionListState(state, emptyList(), reach),
                )
            }
        }
    }

    @Test
    fun `every call denied reads as not permitted`() {
        assertEquals(
            SessionListState.NotPermitted,
            sessionListState(LinkState.Linked, emptyList(), Reach.Denied),
        )
    }

    @Test
    fun `an answer we could not decode reads as unreadable`() {
        assertEquals(
            SessionListState.Unreadable,
            sessionListState(LinkState.Linked, emptyList(), Reach.Undecodable),
        )
    }

    @Test
    fun `linked but never answered reads as loading`() {
        assertEquals(
            SessionListState.Loading,
            sessionListState(LinkState.Linked, emptyList(), Reach.Never),
        )
    }

    @Test
    fun `only a delivered empty answer may claim there are no sessions`() {
        // The one route to "No sessions are running on this desktop." Before
        // this existed, three other situations reached that sentence and lied.
        assertEquals(
            SessionListState.Empty,
            sessionListState(LinkState.Linked, emptyList(), Reach.Delivered),
        )
    }
}
