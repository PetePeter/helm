package com.potatomotato.helm.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import com.potatomotato.helm.log.HelmLog
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService

/**
 * [CallMic] on one AudioRecord feeding an offline Vosk recogniser.
 *
 * Why not Android's SpeechRecognizer: it is per-utterance dictation. Every pause
 * closes it, every restart re-binds the service and grabs audio focus (which
 * churned the Bluetooth headset's call link), and it cannot listen while Helm
 * speaks. One stream recorded as VOICE_COMMUNICATION gets the platform echo
 * canceller — the same one a phone call uses — so the mic stays open while Helm
 * talks and the user can interrupt.
 *
 * Translation only: bytes in, text out. What counts as speech is [CallController]'s.
 */
class VoskCallMic(private val context: Context) : CallMic {
    private val main = Handler(Looper.getMainLooper())

    /** Written on main, read by the reader thread; null once released. */
    @Volatile private var listener: CallMic.Listener? = null

    override fun start(listener: CallMic.Listener) {
        this.listener = listener
        loadModel(
            context,
            ready = { model -> if (this.listener === listener) open(model, listener) },
            failed = { reason -> deliver(listener) { it.onFailed(reason) } },
        )
    }

    override fun release() {
        // The reader loop sees this within one frame and closes everything itself.
        listener = null
    }

    @SuppressLint("MissingPermission") // The call screen gates on VoicePermission first.
    private fun open(model: Model, listener: CallMic.Listener) {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        val record = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE, CHANNEL, ENCODING,
                maxOf(minBuffer, FRAME_SAMPLES * 2) * 2)
        }.getOrNull()
        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            record?.release()
            deliver(listener) { it.onFailed("the microphone could not be opened") }
            return
        }
        val effects = listOfNotNull(
            enable("echo canceller", AcousticEchoCanceler.isAvailable()) { AcousticEchoCanceler.create(record.audioSessionId) },
            enable("noise suppressor", NoiseSuppressor.isAvailable()) { NoiseSuppressor.create(record.audioSessionId) },
        )
        val recognizer = Recognizer(model, SAMPLE_RATE.toFloat())
        Thread({ loop(record, recognizer, effects, listener) }, "helm-call-mic").apply { start() }
        HelmLog.i(HelmLog.UI, "call mic open (voice communication, ${effects.size} effect(s))")
    }

    private fun loop(record: AudioRecord, recognizer: Recognizer, effects: List<AudioEffect>, owner: CallMic.Listener) {
        val frame = ShortArray(FRAME_SAMPLES)
        var lastPartial = ""
        try {
            record.startRecording()
            while (listener === owner) {
                val read = record.read(frame, 0, frame.size)
                if (read < 0) {
                    deliver(owner) { it.onFailed("the microphone stopped (code $read)") }
                    break
                }
                if (read == 0) continue
                if (recognizer.acceptWaveForm(frame, read)) {
                    lastPartial = ""
                    val text = field(recognizer.result, "text")
                    deliver(owner) { it.onFinal(text) }
                } else {
                    val partial = field(recognizer.partialResult, "partial")
                    if (partial != lastPartial) {
                        lastPartial = partial
                        deliver(owner) { it.onPartial(partial) }
                    }
                }
            }
        } catch (e: RuntimeException) {
            deliver(owner) { it.onFailed(e.message ?: "the microphone failed") }
        } finally {
            runCatching { record.stop() }
            record.release()
            effects.forEach { it.release() }
            recognizer.close()
            HelmLog.i(HelmLog.UI, "call mic closed")
        }
    }

    /** Post to main, and only while [owner] is still the live listener. */
    private fun deliver(owner: CallMic.Listener, event: (CallMic.Listener) -> Unit) {
        main.post { if (listener === owner) event(owner) }
    }

    private fun enable(name: String, available: Boolean, create: () -> AudioEffect?): AudioEffect? {
        if (!available) {
            HelmLog.w(HelmLog.UI, "call mic: no $name on this phone")
            return null
        }
        return runCatching { create()?.also { it.enabled = true } }.getOrNull()
    }

    private fun field(json: String, name: String): String =
        runCatching { JSONObject(json).optString(name) }.getOrDefault("").trim()

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** 100ms per read: partials refresh fast enough to interrupt Helm promptly. */
        const val FRAME_SAMPLES = SAMPLE_RATE / 10
        const val ASSET_DIR = "model-en-us"

        /** Loaded once per process: unpacking and loading costs seconds. */
        var model: Model? = null

        fun loadModel(context: Context, ready: (Model) -> Unit, failed: (String) -> Unit) {
            model?.let { return ready(it) }
            StorageService.unpack(
                context.applicationContext, ASSET_DIR, "model",
                { loaded -> model = loaded; ready(loaded) },
                { e -> failed("speech model: ${e.message}") },
            )
        }
    }
}
