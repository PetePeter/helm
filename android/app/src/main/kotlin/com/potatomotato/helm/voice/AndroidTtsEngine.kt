package com.potatomotato.helm.voice

import android.content.Context
import android.media.AudioAttributes
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.potatomotato.helm.log.HelmLog

/**
 * The platform voice, behind [TtsEngine]. Translation only — like
 * [AndroidSpeechEngine], any decision made here could not be tested.
 *
 * A call speaks as VOICE_COMMUNICATION, so the words follow the call's route
 * (earpiece, speaker or the car) rather than the media stream. Standby holds no
 * call audio, so it speaks as ASSISTANT.
 */
class AndroidTtsEngine(
    context: Context,
    usage: Int = AudioAttributes.USAGE_VOICE_COMMUNICATION,
) : TtsEngine {
    private val main = Handler(Looper.getMainLooper())
    /** The engine answered its init, successfully or not. */
    private var initialised = false
    private var ready = false

    /** A line asked for before the engine finished initialising. */
    private var waiting: Pair<String, () -> Unit>? = null

    /** The one onDone still owed, keyed by utterance id so a stale callback is dropped. */
    private var owed: Pair<String, () -> Unit>? = null
    private var sequence = 0

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        main.post {
            initialised = true
            ready = status == TextToSpeech.SUCCESS
            if (!ready) HelmLog.w(HelmLog.UI, "text to speech failed to initialise with status $status")
            waiting?.let { (text, onDone) ->
                waiting = null
                if (ready) speak(text, onDone) else onDone()
            }
        }
    }.apply {
        setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        // A touch brisker than the default: replies are short and the caller is waiting.
        setSpeechRate(SPEECH_RATE)
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                HelmLog.d(HelmLog.UI) { "text to speech done $utteranceId" }
                finished(utteranceId)
            }

            @Deprecated("Required override on older APIs")
            override fun onError(utteranceId: String?) = onError(utteranceId, -1)
            override fun onError(utteranceId: String?, errorCode: Int) {
                HelmLog.w(HelmLog.UI, "text to speech failed on $utteranceId with code $errorCode")
                finished(utteranceId)
            }
        })
    }

    override fun speak(text: String, onDone: () -> Unit) {
        if (!initialised) {
            HelmLog.d(HelmLog.UI) { "text to speech not initialised yet; the line waits" }
            waiting = text to onDone
            return
        }
        // No voice at all: say so by finishing at once, or the call would wait
        // forever with the mic paused.
        if (!ready) {
            main.post(onDone)
            return
        }
        val id = "call-${sequence++}"
        HelmLog.d(HelmLog.UI) { "text to speech speaking $id, ${text.length} chars" }
        owed = id to onDone
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
            HelmLog.w(HelmLog.UI, "text to speech refused an utterance")
            owed = null
            main.post(onDone)
        }
    }

    override fun stop() {
        waiting = null
        owed = null
        tts.stop()
    }

    override fun release() {
        stop()
        tts.shutdown()
    }

    /** Progress callbacks arrive on a binder thread; the controller lives on main. */
    private fun finished(utteranceId: String?) {
        main.post {
            val (id, onDone) = owed ?: return@post
            if (id != utteranceId) return@post
            owed = null
            onDone()
        }
    }

    private companion object {
        const val SPEECH_RATE = 1.15f
    }
}
