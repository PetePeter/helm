package com.potatomotato.helm.telecom

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * The operator's ring as a REAL incoming call (docs/voice-operator.md).
 *
 * Helm registers a self-managed PhoneAccount, so Android treats a ring as a
 * VoIP call: car Bluetooth call screens, steering-wheel and headset buttons can
 * answer or decline it, and a real phone call arriving mid-call is arbitrated
 * by the system. The audio stays ours: answering runs the same Call Helm flow
 * (VoiceCallService) as the notification always did. Any refusal from Telecom
 * returns false so the caller falls back to the plain ring notification.
 */
object HelmTelecom {
    private const val TAG = "HelmTelecom"
    private const val ACCOUNT_ID = "helm-operator"
    const val EXTRA_SESSION = "com.potatomotato.helm.telecom.SESSION"
    const val EXTRA_NAME = "com.potatomotato.helm.telecom.NAME"
    const val EXTRA_REASON = "com.potatomotato.helm.telecom.REASON"

    /** The one call in flight, if any. Connection callbacks all arrive on the main thread. */
    @Volatile
    internal var current: HelmConnection? = null

    private fun handle(context: Context) = PhoneAccountHandle(
        ComponentName(context, HelmConnectionService::class.java),
        ACCOUNT_ID,
    )

    /** Offer the ring to Telecom. False when it cannot take it (refused, no permission, a call already up). */
    fun offer(context: Context, sessionId: String, sessionName: String, reason: String): Boolean = try {
        val telecom = context.getSystemService(TelecomManager::class.java)
        val account = handle(context)
        telecom.registerPhoneAccount(
            PhoneAccount.builder(account, "Helm")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build(),
        )
        if (current != null || !telecom.isIncomingCallPermitted(account)) {
            false
        } else {
            val extras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, Uri.fromParts("helm", sessionId, null))
                putString(EXTRA_SESSION, sessionId)
                putString(EXTRA_NAME, sessionName)
                putString(EXTRA_REASON, reason)
            }
            telecom.addNewIncomingCall(account, extras)
            true
        }
    } catch (error: RuntimeException) {
        // SecurityException (permission), IllegalArgumentException (account), or
        // anything else: the notification still rings.
        Log.w(TAG, "Telecom refused the ring: ${error.javaClass.simpleName}")
        false
    }

    /** The call really started: the car shows it as active. */
    fun active() {
        current?.setActive()
    }

    /** Declined from Helm's own notification. */
    fun reject() {
        current?.onReject()
    }

    /** The Call Helm call ended on our side: end the system call with it. */
    fun end() {
        current?.endFromApp()
    }
}
