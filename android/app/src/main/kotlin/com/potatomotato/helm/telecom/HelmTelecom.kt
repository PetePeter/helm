package com.potatomotato.helm.telecom

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import com.potatomotato.helm.voice.AudioRoute
import com.potatomotato.helm.voice.CallRefusal

/**
 * Every Helm call as a REAL call (docs/voice-operator.md): a ring is an
 * incoming one, "Call Helm" an outgoing one.
 *
 * Helm registers a self-managed PhoneAccount, so Android treats each as a VoIP
 * call: car Bluetooth call screens, steering-wheel and headset buttons can
 * answer, decline, hang up and mute it, and a real phone call arriving mid-call
 * is arbitrated by the system. The audio stays ours (VoiceCallService).
 *
 * There is no call outside Telecom: one it refuses does not happen, so mute and
 * hang-up from the car never meet a call they cannot reach.
 */
object HelmTelecom {
    private const val TAG = "HelmTelecom"
    private const val ACCOUNT_ID = "helm-operator"
    private const val SCHEME = "helm"
    const val EXTRA_SESSION = "com.potatomotato.helm.telecom.SESSION"
    const val EXTRA_NAME = "com.potatomotato.helm.telecom.NAME"
    const val EXTRA_REASON = "com.potatomotato.helm.telecom.REASON"

    /** The one call in flight, if any. Connection callbacks all arrive on the main thread. */
    @Volatile
    internal var current: HelmConnection? = null

    /** Asked of Telecom and not yet answered: runs once, with whether the call was created. */
    private var pending: ((created: Boolean) -> Unit)? = null

    /** The live call's audio state changed (mute, route). Set by the call while it is up. */
    @Volatile
    var onAudioState: (() -> Unit)? = null

    /** The route and routes Telecom confirms for the live call. */
    @Volatile
    var onRouteState: ((AudioRoute?, Set<AudioRoute>) -> Unit)? = null

    private val busy get() = current != null || pending != null

    private fun account(context: Context, telecom: TelecomManager): PhoneAccountHandle {
        val handle = PhoneAccountHandle(ComponentName(context, HelmConnectionService::class.java), ACCOUNT_ID)
        telecom.registerPhoneAccount(
            PhoneAccount.builder(handle, "Helm")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .addSupportedUriScheme(SCHEME)
                .build(),
        )
        return handle
    }

    private fun address(sessionId: String): Uri = Uri.fromParts(SCHEME, sessionId, null)

    /**
     * Offer a ring to Telecom. False when it cannot take it (refused, no
     * permission, a call already up); [refused] runs instead when it takes the
     * ring and then fails to create it. Either way nothing rings.
     */
    fun offer(context: Context, sessionId: String, sessionName: String, reason: String, refused: () -> Unit): Boolean =
        try {
            val telecom = context.getSystemService(TelecomManager::class.java)
            val account = account(context, telecom)
            if (busy || !telecom.isIncomingCallPermitted(account)) {
                false
            } else {
                pending = { created -> if (!created) refused() }
                telecom.addNewIncomingCall(
                    account,
                    Bundle().apply {
                        putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, address(sessionId))
                        putString(EXTRA_SESSION, sessionId)
                        putString(EXTRA_NAME, sessionName)
                        putString(EXTRA_REASON, reason)
                    },
                )
                true
            }
        } catch (error: RuntimeException) {
            // SecurityException (permission), IllegalArgumentException (account), or anything else.
            Log.w(TAG, "Telecom refused the ring: ${error.javaClass.simpleName}")
            pending = null
            false
        }

    /**
     * Register a call the user is starting. A refusal known at once is
     * returned; otherwise null, and [answer] runs when Telecom has created the
     * call (true) or failed to (false).
     */
    @SuppressLint("MissingPermission") // MANAGE_OWN_CALLS is install-time; a refusal is caught below.
    fun place(context: Context, sessionId: String, sessionName: String, answer: (created: Boolean) -> Unit): CallRefusal? =
        try {
            val telecom = context.getSystemService(TelecomManager::class.java)
            val account = account(context, telecom)
            if (busy || !telecom.isOutgoingCallPermitted(account)) {
                CallRefusal.Busy
            } else {
                pending = answer
                telecom.placeCall(
                    address(sessionId),
                    Bundle().apply {
                        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, account)
                        putBundle(
                            TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS,
                            Bundle().apply {
                                putString(EXTRA_SESSION, sessionId)
                                putString(EXTRA_NAME, sessionName)
                            },
                        )
                    },
                )
                null
            }
        } catch (error: RuntimeException) {
            Log.w(TAG, "Telecom refused the call: ${error.javaClass.simpleName}")
            pending = null
            CallRefusal.Unavailable
        }

    /** A request is still waiting for Telecom. False once it was hung up: that call must not be created. */
    internal val waiting get() = pending != null

    /** Telecom's answer to the request in flight. */
    internal fun answer(created: Boolean) {
        val answer = pending ?: return
        pending = null
        answer(created)
    }

    /** The call really started: the car shows it as active. */
    fun active() {
        current?.setActive()
    }

    /** Ask Telecom to route the live self-managed call. The callback publishes the accepted route. */
    fun setAudioRoute(route: AudioRoute) {
        current?.requestAudioRoute(route)
    }

    /** Re-publish the current route when the foreground service joins a live call. */
    fun publishAudioRoute() {
        current?.publishAudioRoute()
    }

    /** Declined from Helm's own notification. */
    fun reject() {
        current?.onReject()
    }

    /** The Call Helm call ended on our side: end the system call with it, or stop waiting for one. */
    fun end() {
        pending = null
        current?.endFromApp()
    }
}
