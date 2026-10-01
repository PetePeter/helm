package com.potatomotato.helm.telecom

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle

/** Telecom's entry point for Helm's calls; each becomes one [HelmConnection]. */
class HelmConnectionService : ConnectionService() {

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection =
        create(request, outgoing = false)

    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection =
        create(request, outgoing = true)

    /** Telecom said no after all (another call, policy): there is no call. */
    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        HelmTelecom.answer(created = false)
    }

    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        HelmTelecom.answer(created = false)
    }

    private fun create(request: ConnectionRequest?, outgoing: Boolean): Connection {
        // Hung up before Telecom got here: nobody is waiting for this call.
        if (!HelmTelecom.waiting) return Connection.createCanceledConnection()
        val extras = request?.extras
        val connection = HelmConnection(
            context = applicationContext,
            sessionId = extras?.getString(HelmTelecom.EXTRA_SESSION).orEmpty(),
            sessionName = extras?.getString(HelmTelecom.EXTRA_NAME).orEmpty(),
            reason = extras?.getString(HelmTelecom.EXTRA_REASON).orEmpty(),
            outgoing = outgoing,
        )
        // In place before the answer: an outgoing call turns active from inside it.
        HelmTelecom.current = connection
        HelmTelecom.answer(created = true)
        return connection
    }
}
