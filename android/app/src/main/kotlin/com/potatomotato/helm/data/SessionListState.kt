package com.potatomotato.helm.data

import com.potatomotato.helm.ble.LinkState

/**
 * How the last attempt to learn the world went.
 *
 * The session list starts empty, and an empty list on its own cannot tell you
 * whether the desktop said "nothing is running" or whether nobody ever managed
 * to ask. Both looked identical on the phone, and the app then asserted the
 * first one as fact — at the exact moment pairing had reported SUCCESS.
 */
enum class Reach {
    /** Nobody has answered on this link yet. */
    Never,

    /** An answer arrived and was understood. An EMPTY answer still counts. */
    Delivered,

    /** The gate refused. Which rule refused is deliberately unknowable (gotcha 8). */
    Denied,

    /** An answer arrived and this app could not read it. Ours to own, not the desktop's. */
    Undecodable,
}

/** What the session list should say when it has nothing to draw. */
enum class SessionListState {
    Populated,
    NoLink,
    NotPermitted,
    Unreadable,
    Loading,
    Empty,
}

/**
 * Decide what the list is actually saying.
 *
 * The ordering is the design, so read it as prose:
 *
 * 1. **Stale data beats a lie.** A list we already hold is shown whatever else
 *    is true. The user's link churns constantly, and a phone that blanked on
 *    every drop would be a flickering screen rather than a status display.
 * 2. **No link outranks anything we learned while we had one.** This is gotcha
 *    31 one layer up: "we could not ask" must not render as "you may not". With
 *    the radio down, a denial we saw a minute ago is no longer known to be current.
 * 3. Only then do the reasons we actually learned get to speak.
 * 4. **[SessionListState.Empty] is the last rung, reachable only by a delivered
 *    answer.** It is the sole route to "No sessions are running on this desktop",
 *    which is the only sentence here that claims to know something about the
 *    desktop rather than about this app's own situation.
 */
fun sessionListState(
    linkState: LinkState,
    sessions: List<HelmSession>,
    reach: Reach,
): SessionListState = when {
    sessions.isNotEmpty() -> SessionListState.Populated
    linkState != LinkState.Linked -> SessionListState.NoLink
    reach == Reach.Denied -> SessionListState.NotPermitted
    reach == Reach.Undecodable -> SessionListState.Unreadable
    reach == Reach.Never -> SessionListState.Loading
    else -> SessionListState.Empty
}
