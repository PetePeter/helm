package com.potatomotato.helm.telecom

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle
import com.potatomotato.helm.notify.IncomingRing

/** Telecom's entry point for Helm's rings; each becomes one [HelmConnection]. */
class HelmConnectionService : ConnectionService() {

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val extras = request?.extras
        val connection = HelmConnection(
            context = applicationContext,
            sessionId = extras?.getString(HelmTelecom.EXTRA_SESSION).orEmpty(),
            sessionName = extras?.getString(HelmTelecom.EXTRA_NAME).orEmpty(),
            reason = extras?.getString(HelmTelecom.EXTRA_REASON).orEmpty(),
        )
        HelmTelecom.current = connection
        return connection
    }

    /** Telecom said no after all (another call, policy): ring the old way instead. */
    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        val extras = request?.extras ?: return
        IncomingRing(applicationContext).show(
            extras.getString(HelmTelecom.EXTRA_SESSION).orEmpty(),
            extras.getString(HelmTelecom.EXTRA_NAME).orEmpty(),
            extras.getString(HelmTelecom.EXTRA_REASON).orEmpty(),
        )
    }
}
