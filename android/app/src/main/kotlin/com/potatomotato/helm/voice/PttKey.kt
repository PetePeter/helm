package com.potatomotato.helm.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import com.potatomotato.helm.MainActivity
import androidx.core.content.ContextCompat
import com.potatomotato.helm.log.HelmLog

/**
 * The Motorola AI Key as a walkie-talkie. With the key's PTT option on, Motorola's
 * MyKey broadcasts [ACTION_DOWN] / [ACTION_UP] to anyone listening: hold to talk
 * into the session open on screen, let go to hear its replies.
 *
 * The broadcasts carry no sender permission, so any app can fake them. A fake
 * can only start a call while the screen is on, to the session the user has
 * open, and the call opens with an audible cue.
 */
sealed interface PttKey {
    data class Start(val targetId: String) : PttKey
    data class Hold(val held: Boolean) : PttKey
    data object Ignore : PttKey

    companion object {
        const val ACTION_DOWN = "android.intent.action.PTT.down"
        const val ACTION_UP = "android.intent.action.PTT.up"

        /** The session on screen, else the operator; published by HelmHome. */
        @Volatile
        var target: String? = null

        /**
         * A call the key asked for, parked for [MainActivity]: only an app on
         * screen may start the microphone, so the press brings Helm forward
         * first. In process, not an extra — the activity is exported.
         */
        @Volatile
        var pendingStart: String? = null

        /** The key is down now; read when the parked call finally starts. */
        @Volatile
        var held = false

        /** For [MainActivity]: start the parked call, if any. Returns its target. */
        fun takePendingStart(context: Context): String? {
            val target = pendingStart ?: return null
            pendingStart = null
            VoiceCallService.start(context, target, pushToTalk = true)
            // Let go while Helm was coming forward: the call opens muted.
            if (!held) VoiceCallService.setPttKeyHeld(context, false)
            return target
        }

        fun decide(down: Boolean, liveCall: Boolean, target: String?, screenOn: Boolean): PttKey = when {
            // A release always goes through: it may land while the call is still being placed.
            !down -> Hold(false)
            liveCall -> Hold(true)
            !screenOn || target == null -> Ignore
            else -> Start(target)
        }

        /** Listens for as long as its owner (the link service) lives; returns the unregister. */
        fun listen(context: Context): () -> Unit {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    val down = when (intent.action) {
                        ACTION_DOWN -> true
                        ACTION_UP -> false
                        else -> return
                    }
                    val action = decide(
                        down = down,
                        liveCall = VoiceCallService.call.value != null,
                        target = target,
                        screenOn = context.getSystemService(PowerManager::class.java).isInteractive,
                    )
                    HelmLog.i(HelmLog.UI, "PTT key ${if (down) "down" else "up"}: ${action::class.simpleName}")
                    held = down
                    when (action) {
                        is Start -> {
                            pendingStart = action.targetId
                            context.startActivity(
                                Intent(context, MainActivity::class.java)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                            )
                        }
                        is Hold -> VoiceCallService.setPttKeyHeld(context, action.held)
                        Ignore -> Unit
                    }
                }
            }
            val filter = IntentFilter().apply {
                addAction(ACTION_DOWN)
                addAction(ACTION_UP)
            }
            ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
            return { runCatching { context.unregisterReceiver(receiver) } }
        }
    }
}
