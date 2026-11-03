package com.potatomotato.helm.voice

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.content.ContextCompat
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.operator.KeyPress
import com.potatomotato.helm.ui.operator.OperatorKey

/**
 * The Motorola AI Key as a walkie-talkie. With the key's PTT option on, Motorola's
 * MyKey broadcasts [ACTION_DOWN] / [ACTION_UP] to anyone listening: hold to talk
 * into the session open on screen, let go to hear its replies.
 *
 * The broadcasts carry no sender permission, so any app can fake them. A fake
 * can only call the session the user has open (else the operator), a locked
 * phone only as [KeyPress.gate] allows, and the call opens with an audible cue.
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

        fun decide(down: Boolean, liveCall: Boolean, target: String?): PttKey = when {
            // A release always goes through: it may land while the call is still being placed.
            !down -> Hold(false)
            liveCall -> Hold(true)
            target == null -> Ignore
            else -> Start(target)
        }

        /** One spoken line with no call to speak it in: on the media stream, then released. */
        private fun say(context: Context, text: String) {
            var tts: TextToSpeech? = null
            tts = TextToSpeech(context.applicationContext) { status ->
                val engine = tts ?: return@TextToSpeech
                if (status != TextToSpeech.SUCCESS) return@TextToSpeech engine.shutdown()
                engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) = engine.shutdown()
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) = engine.shutdown()
                })
                engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ptt-unlock")
            }
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
                    )
                    HelmLog.i(HelmLog.UI, "PTT key ${if (down) "down" else "up"}: ${action::class.simpleName}")
                    held = down
                    when (action) {
                        is Start -> {
                            // The operator key's lock rule: a phone just used may call over the lock screen.
                            val press = KeyPress.gate(
                                locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked,
                                inCall = false,
                                now = SystemClock.elapsedRealtime(),
                                callEndedAt = OperatorKey.callEndedAt,
                                screenOffAt = OperatorKey.screenOffAt,
                            )
                            if (press !is KeyPress.Open) {
                                HelmLog.i(HelmLog.UI, "PTT key ignored: locked too long, unlock first")
                                say(context, context.getString(R.string.ptt_unlock_first))
                                return
                            }
                            OperatorKey.overLockScreen = press.overLockScreen
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
