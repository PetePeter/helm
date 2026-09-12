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

        // One recogniser per utterance keeps the platform's own state out of the
        // picture: a fresh instance cannot be left half-cancelled by the last run.
        release()
        val created = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(Bridge(listener))
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
        }

    /** Android's listener, adapted. Nothing but translation happens here. */
    private class Bridge(private val out: SpeechEngine.Listener) : RecognitionListener {
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
            out.onError(toSpeechError(error))
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

        fun toSpeechError(code: Int): SpeechError = when (code) {
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> SpeechError.PermissionDenied
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            -> SpeechError.NoMatch
            SpeechRecognizer.ERROR_AUDIO,
            SpeechRecognizer.ERROR_CLIENT,
            -> SpeechError.Audio
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            -> SpeechError.Network
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> SpeechError.Busy
            SpeechRecognizer.ERROR_SERVER -> SpeechError.NoSpeechService
            else -> SpeechError.Unknown
        }
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
