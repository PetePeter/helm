package com.potatomotato.helm.notify

import java.security.SecureRandom
import java.util.Base64

/**
 * One-shot proof that an Answer came from OUR ring notification.
 *
 * MainActivity is exported (it is the launcher), so any app can start it with
 * the accept extra. Answering shows Helm over the lock screen and starts the
 * microphone, so the accept path must only honour an intent carrying the ticket
 * minted for the ring on screen. The ticket lives in process memory: if the
 * process died between ring and answer, the answer degrades to opening the app.
 */
class RingTicket(private val random: SecureRandom = SecureRandom()) {
    private var issued: Pair<String, String>? = null

    /** Mint the ticket for a new ring; replaces any earlier one. */
    @Synchronized
    fun issue(sessionId: String): String {
        val bytes = ByteArray(TICKET_BYTES).also(random::nextBytes)
        val ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        issued = sessionId to ticket
        return ticket
    }

    /** True once, for the session and ticket just issued. */
    @Synchronized
    fun redeem(sessionId: String, ticket: String?): Boolean {
        val ok = ticket != null && issued == (sessionId to ticket)
        if (ok) issued = null
        return ok
    }

    private companion object {
        const val TICKET_BYTES = 16
    }
}
