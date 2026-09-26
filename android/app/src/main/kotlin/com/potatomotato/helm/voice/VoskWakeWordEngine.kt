package com.potatomotato.helm.voice

import android.content.Context
import android.os.SystemClock
import com.potatomotato.helm.log.HelmLog
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService

/**
 * [WakeWordEngine] on Vosk: offline keyword spotting, nothing leaves the phone.
 *
 * Vosk's [SpeechService] reads ONE AudioRecord continuously (16 kHz mono,
 * VOICE_RECOGNITION) into a recogniser restricted to [WakeDetector.GRAMMAR],
 * so there is no per-utterance recogniser churn. The model ships in the APK
 * assets and is unpacked to filesDir once; the loaded [Model] is kept for the
 * process, since reloading it on every standby costs seconds.
 */
class VoskWakeWordEngine(private val context: Context) : WakeWordEngine {
    private var service: SpeechService? = null
    private var recognizer: Recognizer? = null
    private var stopped = false

    override fun start(onWake: () -> Unit, onError: (String) -> Unit) {
        stopped = false
        loadModel(context, { model -> if (!stopped) listen(model, onWake, onError) }, onError)
    }

    private fun listen(model: Model, onWake: () -> Unit, onError: (String) -> Unit) {
        val detector = WakeDetector()
        val rec = Recognizer(model, SAMPLE_RATE, WakeDetector.GRAMMAR).apply { setWords(true) }
        recognizer = rec
        val speech = SpeechService(rec, SAMPLE_RATE)
        service = speech
        speech.startListening(object : RecognitionListener {
            override fun onPartialResult(hypothesis: String?) = Unit
            override fun onResult(hypothesis: String?) = check(hypothesis)
            override fun onFinalResult(hypothesis: String?) = check(hypothesis)
            override fun onError(exception: Exception?) = onError(exception?.message ?: "wake word engine failed")
            override fun onTimeout() = Unit

            private fun check(hypothesis: String?) {
                if (hypothesis == null || !detector.accept(hypothesis, SystemClock.elapsedRealtime())) return
                HelmLog.i(HelmLog.UI, "wake word detected")
                onWake()
            }
        })
        HelmLog.i(HelmLog.UI, "wake word listening")
    }

    override fun stop() {
        stopped = true
        val speech = service ?: return
        service = null
        speech.stop()
        speech.shutdown()
        recognizer?.close()
        recognizer = null
    }

    private companion object {
        const val SAMPLE_RATE = 16_000f
        const val ASSET_DIR = "model-en-us"
        var model: Model? = null

        fun loadModel(context: Context, ready: (Model) -> Unit, failed: (String) -> Unit) {
            model?.let { return ready(it) }
            StorageService.unpack(
                context.applicationContext, ASSET_DIR, "model",
                { loaded -> model = loaded; ready(loaded) },
                { e -> failed("wake word model: ${e.message}") },
            )
        }
    }
}
