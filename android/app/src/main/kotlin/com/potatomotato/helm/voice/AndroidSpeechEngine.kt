package com.potatomotato.helm.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.potatomotato.helm.Permissions
import com.potatomotato.helm.log.HelmLog

/**
 * The platform recogniser, behind [SpeechEngine].
 *
 * This file is translation only — Android callbacks in, port callbacks out. Any
 * decision made here would be a decision that cannot be tested, so decisions
 * live in [SpeechController] instead.
 *
 * Recognition is requested OFFLINE: the phone is used away from the desk and the
 * whole point of on-device STT is that it needs no network and uploads nothing.
 */
class AndroidSpeechEngine(private val context: Context) : SpeechEngine {
    private var recognizer: SpeechRecognizer? = null

    override fun start(listener: SpeechEngine.Listener) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            listener.onError(SpeechError.NoSpeechService)
            return
        }

        // ONE recogniser instance for the engine's lifetime, reused across
        // utterances. Creating and destroying per utterance forces a fresh
        // recognition-service bind every restart — the 300ms..1s gap that read
        // as a hiccup between held segments. The controller is a 1:1 companion
        // of this engine, so the listener registered at creation is always the
        // one each start() would hand in.
        val existing = recognizer
        if (existing != null) {
            existing.startListening(recognitionIntent())
            return
        }
        val created = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(Bridge(listener, ::invalidate))
        }
        recognizer = created
        created.startListening(recognitionIntent())
    }

    override fun stop() {
        recognizer?.stopListening()
    }

    override fun cancel() {
        recognizer?.cancel()
    }

    override fun release() {
        recognizer?.destroy()
        recognizer = null
    }

    /**
     * An error can leave the platform recogniser unwilling to listen again;
     * drop it so the next start() builds a fresh one. Called by the bridge
     * AFTER the error is delivered, so the controller always hears it first.
     */
    private fun invalidate() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun recognitionIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // No network, no upload. A device without a downloaded language pack
            // surfaces as SpeechError.Network rather than silently going online.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Best-effort, honoured by Google's recognizer only: a longer
            // end-of-speech silence window, so a mid-hold thinking pause does
            // not close the utterance. When the platform closes it anyway, the
            // controller reopens the mic (see SpeechController.onFinal).
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                COMPLETE_SILENCE_MILLIS,
            )
        }

    /** Android's listener, adapted. Nothing but translation happens here. */
    private class Bridge(
        private val out: SpeechEngine.Listener,
        private val onFailed: () -> Unit,
    ) : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = out.onReady()

        override fun onRmsChanged(rmsdB: Float) = out.onLevel(normaliseRms(rmsdB))

        override fun onPartialResults(partialResults: Bundle?) {
            firstResult(partialResults)?.let(out::onPartial)
        }

        override fun onResults(results: Bundle?) = out.onFinal(firstResult(results).orEmpty())

        override fun onError(error: Int) {
            // The raw code, not just the mapped error: Google's service reports
            // values outside the public SpeechRecognizer constants, and the
            // difference between "no language pack" and "service broken" is
            // only visible in this number. A code is a type, never a payload.
            HelmLog.w(HelmLog.UI, "speech recognition failed with code $error")
            out.onError(speechErrorOf(error))
            onFailed()
        }

        override fun onBeginningOfSpeech() = Unit
        override fun onEndOfSpeech() = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        private fun firstResult(bundle: Bundle?): String? = bundle
            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
    }

    private companion object {
        /**
         * RMS arrives in dB over roughly -2..10 on most devices, and undocumented
         * outside that. Clamped to 0f..1f so the waveform cannot draw off-screen
         * on a device that reports something wilder.
         */
        fun normaliseRms(rmsdB: Float): Float =
            ((rmsdB - RMS_FLOOR_DB) / (RMS_CEILING_DB - RMS_FLOOR_DB)).coerceIn(0f, 1f)

        const val RMS_FLOOR_DB = -2f
        const val RMS_CEILING_DB = 10f

        /** End-of-speech silence window. Long enough to think mid-sentence. */
        const val COMPLETE_SILENCE_MILLIS = 2500L
    }
}

/**
 * Dictation needs exactly one runtime permission. It is requested when the user
 * first taps the mic, never at launch: the app is useful without it.
 */
object VoicePermission {
    val required: List<String> = listOf(Manifest.permission.RECORD_AUDIO)

    fun granted(context: Context): Boolean = Permissions.allGranted(context, required)
}
