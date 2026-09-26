package com.potatomotato.helm.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HeyHelmSetting
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.HelmLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * VoiceCallService — holds a "Call Helm" call through screen-off.
 *
 * A `microphone` foreground service, because a call that dies when the screen
 * sleeps is not a call. The audio side is the phone-call shape: the mode is
 * MODE_IN_COMMUNICATION for the call's lifetime (and restored after), focus is
 * held, and the route is earpiece / speaker / Bluetooth with Bluetooth taken
 * whenever it is there.
 *
 * It also holds "Hey Helm" standby: a [WakeWordEngine] (Vosk keyword spotting)
 * in the same microphone service, with none of the call's audio takeover —
 * standby runs for hours, so it must not hold focus or the communication mode
 * while music plays. The wake word frees the recorder and rings a full call;
 * a call started during standby replaces it, and standby resumes when the call ends ONLY if
 * the switch is still on ([StandbyPolicy]); otherwise the service stops and the
 * mic is released. The switch is observed here, so turning it off always stops
 * standby.
 *
 * Wiring only. What the call does is [CallController]; which route it takes is
 * [pickAudioRoute]; what counts as a reply is [CallFeed].
 */
class VoiceCallService : Service() {

    /** One live call, as the call screen draws it. */
    data class Call(
        val targetId: String,
        val state: CallState,
        val route: AudioRoute,
        val routes: Set<AudioRoute>,
    )

    companion object {
        private const val CHANNEL_ID = "helm_call"
        private const val NOTIFICATION_ID = 2
        private const val ACTION_START = "com.potatomotato.helm.call.START"
        private const val ACTION_STANDBY = "com.potatomotato.helm.call.STANDBY"
        private const val ACTION_STOP_STANDBY = "com.potatomotato.helm.call.STOP_STANDBY"
        private const val ACTION_HANG_UP = "com.potatomotato.helm.call.HANG_UP"
        private const val ACTION_MUTE = "com.potatomotato.helm.call.MUTE"
        private const val ACTION_ROUTE = "com.potatomotato.helm.call.ROUTE"
        private const val EXTRA_TARGET = "target"
        private const val EXTRA_VALUE = "value"
        private const val CUE_VOLUME = 80
        private const val CUE_MS = 150

        private val _call = MutableStateFlow<Call?>(null)

        /** The live call, or null. Process-scoped: there is at most one call. */
        val call: StateFlow<Call?> = _call.asStateFlow()

        private val _standingBy = MutableStateFlow(false)

        /** "Hey Helm" standby is running. */
        val standingBy: StateFlow<Boolean> = _standingBy.asStateFlow()

        fun start(context: Context, targetId: String) {
            context.startForegroundService(command(context, ACTION_START).putExtra(EXTRA_TARGET, targetId))
        }

        /** Listen for "Hey Helm" on behalf of [targetId]. A live call is left alone. */
        fun standby(context: Context, targetId: String) {
            context.startForegroundService(command(context, ACTION_STANDBY).putExtra(EXTRA_TARGET, targetId))
        }

        fun stopStandby(context: Context) = context.startService(command(context, ACTION_STOP_STANDBY))

        fun hangUp(context: Context) = context.startService(command(context, ACTION_HANG_UP))

        fun setMuted(context: Context, muted: Boolean) =
            context.startService(command(context, ACTION_MUTE).putExtra(EXTRA_VALUE, muted))

        fun setRoute(context: Context, route: AudioRoute) =
            context.startService(command(context, ACTION_ROUTE).putExtra(EXTRA_VALUE, route.name))

        private fun command(context: Context, action: String) =
            Intent(context, VoiceCallService::class.java).setAction(action)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var audio: AudioManager
    /** The live call, or null. */
    private var controller: CallController? = null

    /** "Hey Helm" standby's ear, or null. Never live at the same time as [controller]. */
    private var wake: WakeWordEngine? = null

    /** The call's target, or standby's. */
    private var targetId: String? = null

    private val standby get() = wake != null

    /** Standby's target while a call holds the service, so standby can come back. */
    private var standbyTarget: String? = null

    /** The live controller's collectors; cancelled when it is swapped out. */
    private var job: Job? = null
    private var tone: ToneGenerator? = null
    /** The stream [tone] was built on: a call cues on the call's route, standby on notifications. */
    private var toneStream = AudioManager.STREAM_NOTIFICATION

    /** takeAudio() ran: the mode, focus and route are ours to restore. */
    private var active = false
    private var savedMode = AudioManager.MODE_NORMAL
    private var focus: AudioFocusRequest? = null
    private var route: AudioRoute? = null

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = applyRoute(route)
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = applyRoute(route)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        audio = getSystemService(AudioManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.call_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.call_channel_description)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        // The service obeys the switch itself, so turning it off frees the mic
        // however the UI happens to be composed (or not composed at all).
        scope.launch {
            HeyHelmSetting.enabled.collect { on -> if (!on) switchedOff() }
        }
    }

    /** Standby stops now; a live call just loses its comeback. */
    private fun switchedOff() {
        standbyTarget = null
        if (standby) {
            endCurrent()
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        val call = controller
        // Both start paths go foreground FIRST, whatever happens next: a service
        // started with startForegroundService that never calls startForeground
        // crashes.
        if (action == ACTION_START) {
            // A live call keeps its own target; a second START only rejoins it.
            // A START during standby replaces the standby.
            val target = (if (call != null) targetId else null) ?: intent.getStringExtra(EXTRA_TARGET)
            startForegroundWith(target, standby = false)
            when {
                target == null -> if (call == null && !standby) stopSelf()
                call == null -> {
                    if (standby) standbyTarget = targetId
                    endCurrent()
                    begin(target)
                }
            }
            return START_NOT_STICKY
        }
        if (action == ACTION_STANDBY) {
            val target = intent.getStringExtra(EXTRA_TARGET)
            if (call != null) {
                // A live call wins; standby comes back when it ends.
                startForegroundWith(targetId, standby = false)
                standbyTarget = target
                return START_NOT_STICKY
            }
            startForegroundWith(target, standby = true)
            when {
                target == null -> {
                    endCurrent()
                    stopSelf()
                }
                !standby || target != targetId -> {
                    endCurrent()
                    beginStandby(target)
                }
            }
            return START_NOT_STICKY
        }
        if (action == ACTION_STOP_STANDBY) {
            // The notification's Stop is the switch: standby must not come back
            // on the next app open after the user silenced it. The app's own
            // stops (switch off, no target) leave the switch as it is.
            if (intent.getBooleanExtra(EXTRA_VALUE, false)) HeyHelmSetting.set(false)
            switchedOff()
            if (controller == null) stopSelf()
            return START_NOT_STICKY
        }
        // Any other command with nothing live would start a ghost service and
        // touch the audio stack for nothing; during standby it is a no-op.
        if (call == null) {
            if (!standby) stopSelf()
            return START_NOT_STICKY
        }
        when (action) {
            ACTION_HANG_UP -> call.hangUp()
            ACTION_MUTE -> call.setMuted(intent.getBooleanExtra(EXTRA_VALUE, false))
            ACTION_ROUTE -> intent.getStringExtra(EXTRA_VALUE)
                ?.let { name -> AudioRoute.entries.firstOrNull { it.name == name } }
                ?.let(::applyRoute)
        }
        // A killed call is not resumed behind the user's back.
        return START_NOT_STICKY
    }

    private fun begin(target: String) {
        targetId = target
        HelmLog.i(HelmLog.UI, "voice call starting")
        if (!takeAudio()) {
            stopSelf()
            return
        }

        val client = HelmPairing.client
        val call = CallController(
            speech = AndroidSpeechEngine(this),
            tts = AndroidTtsEngine(this),
            send = { text ->
                // The instant "heard you": the reply is seconds away, silence reads as deaf.
                cue(AudioManager.STREAM_VOICE_CALL)
                HelmLog.d(HelmLog.UI) { "call sending ${text.length} chars" }
                client.sendChat(target, text)
            },
            sendFailedLine = getString(R.string.call_send_failed),
        )
        controller = call

        val feed = CallFeed(client.chats.thread(target))
        job = scope.launch {
            launch {
                client.chats.threads.map { it[target].orEmpty() }.distinctUntilChanged().collect { thread ->
                    val events = feed.next(thread)
                    if (events.replies.isNotEmpty()) {
                        HelmLog.i(HelmLog.UI, "call target replied ${events.replies.size} line(s); queued to speak")
                    }
                    events.replies.forEach(call::onReply)
                    repeat(events.failures) { call.onSendFailed() }
                }
            }
            launch {
                call.state.collect { state ->
                    publish(state)
                    if (state.phase == CallPhase.Ended) ended()
                }
            }
        }
        call.start()
    }

    /**
     * "Hey Helm" standby: only the keyword spotter holds the mic - no
     * SpeechRecognizer, no audio takeover, so music keeps playing.
     */
    private fun beginStandby(target: String) {
        targetId = target
        _standingBy.value = true
        HelmLog.i(HelmLog.UI, "hey helm standby starting")
        val engine = VoskWakeWordEngine(this)
        wake = engine
        engine.start(
            onWake = { if (wake === engine) woke(target) },
            onError = { reason ->
                if (wake === engine) {
                    HelmLog.w(HelmLog.UI, "hey helm standby failed: $reason")
                    // Off: the switch must not claim a standby that cannot run.
                    HeyHelmSetting.set(false)
                    endCurrent()
                    stopSelf()
                }
            },
        )
    }

    /** The wake word: free the recorder, beep, and ring [target] as a full call. */
    private fun woke(target: String) {
        endCurrent()
        cue(AudioManager.STREAM_NOTIFICATION)
        standbyTarget = target
        startForegroundWith(target, standby = false)
        begin(target)
    }

    /** The short beep that says "heard you" before the question goes. */
    private fun cue(stream: Int) {
        if (toneStream != stream) {
            tone?.release()
            tone = null
            toneStream = stream
        }
        val generator = tone
            ?: runCatching { ToneGenerator(stream, CUE_VOLUME) }.getOrNull()
            ?: return
        tone = generator
        generator.startTone(ToneGenerator.TONE_PROP_ACK, CUE_MS)
    }

    /**
     * The call ended. With the switch still on it goes back to standby rather
     * than leaving the phone deaf; anything else stops and frees the mic.
     */
    private fun ended() {
        val back = StandbyPolicy.resumeAfter(HeyHelmSetting.enabled.value, standbyTarget ?: targetId)
        standbyTarget = null
        endCurrent()
        releaseAudio()
        if (back == null) {
            stopSelf()
            return
        }
        startForegroundWith(back, standby = true)
        beginStandby(back)
    }

    /** Swap the live call or standby out without stopping the service. */
    private fun endCurrent() {
        job?.cancel()
        job = null
        val live = controller != null || wake != null
        controller?.hangUp()
        controller = null
        wake?.stop()
        wake = null
        if (live) HelmLog.i(HelmLog.UI, "mic released")
        _call.value = null
        _standingBy.value = false
    }

    /** The call's audio: communication mode, focus and route. False when refused. */
    private fun takeAudio(): Boolean {
        active = true
        savedMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener(::onFocusChange, main)
            .build()
        focus = request
        // No focus (a phone call already holds it) means no call of ours.
        if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            HelmLog.w(HelmLog.UI, "voice call refused audio focus, ending")
            return false
        }
        audio.registerAudioDeviceCallback(devices, main)
        applyRoute(null)
        return true
    }

    /**
     * Only undo what [takeAudio] did: a service that never took the audio must
     * not reset the mode or the route out from under a real phone call.
     */
    private fun releaseAudio() {
        if (!active) return
        active = false
        runCatching { audio.unregisterAudioDeviceCallback(devices) }
        releaseRoute()
        focus?.let(audio::abandonAudioFocusRequest)
        focus = null
        route = null
        audio.mode = savedMode
        HelmLog.i(HelmLog.UI, "voice call ended, audio mode restored")
    }

    override fun onDestroy() {
        endCurrent()
        scope.cancel()
        releaseAudio()
        tone?.release()
        tone = null
        super.onDestroy()
    }

    /**
     * A permanent loss (another app's call) ends ours. A transient loss is
     * routine — our own SpeechRecognizer takes transient focus every time it
     * starts listening — so it only ends the call when the phone is actually
     * ringing or in a GSM call.
     */
    private fun onFocusChange(change: Int) {
        val phoneCall = audio.mode == AudioManager.MODE_RINGTONE || audio.mode == AudioManager.MODE_IN_CALL
        val ends = change == AudioManager.AUDIOFOCUS_LOSS ||
            (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT && phoneCall)
        if (ends) {
            HelmLog.i(HelmLog.UI, "voice call lost audio focus ($change), hanging up")
            controller?.hangUp()
        }
    }

    private fun publish(state: CallState = controller?.state?.value ?: CallState()) {
        // Standby is not a call: the call screen never draws it.
        if (standby) return
        val target = targetId ?: return
        _call.value = Call(target, state, route ?: AudioRoute.Earpiece, availableRoutes())
    }

    /** Re-pick against what is reachable now, preferring [wanted]; see [pickAudioRoute]. */
    private fun applyRoute(wanted: AudioRoute?) {
        val next = pickAudioRoute(wanted, availableRoutes())
        route = next
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.availableCommunicationDevices.firstOrNull { routeOf(it.type) == next }
                ?.let(audio::setCommunicationDevice)
        } else {
            @Suppress("DEPRECATION")
            run {
                audio.isSpeakerphoneOn = next == AudioRoute.Speaker
                if (next == AudioRoute.Bluetooth) audio.startBluetoothSco() else audio.stopBluetoothSco()
                audio.isBluetoothScoOn = next == AudioRoute.Bluetooth
            }
        }
        publish()
    }

    private fun releaseRoute() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            run {
                audio.isSpeakerphoneOn = false
                audio.stopBluetoothSco()
                audio.isBluetoothScoOn = false
            }
        }
    }

    private fun availableRoutes(): Set<AudioRoute> {
        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.availableCommunicationDevices.map { it.type }
        } else {
            audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
        }
        return types.mapNotNullTo(HashSet(), ::routeOf) + AudioRoute.Speaker
    }

    private fun routeOf(type: Int): AudioRoute? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRoute.Earpiece
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRoute.Speaker
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> AudioRoute.Bluetooth
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
            AudioRoute.Bluetooth
        } else {
            null
        }
    }

    private fun startForegroundWith(target: String?, standby: Boolean) {
        val name = target?.let { HelmPairing.client.sessions.find(it)?.name ?: it }.orEmpty()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            if (standby) 2 else 1,
            if (standby) {
                command(this, ACTION_STOP_STANDBY).putExtra(EXTRA_VALUE, true)
            } else {
                command(this, ACTION_HANG_UP)
            },
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(if (standby) R.string.hey_helm else R.string.call_helm))
            .setContentText(
                if (standby) {
                    getString(R.string.hey_helm_notification_text)
                } else {
                    getString(R.string.call_notification_text, name)
                },
            )
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                    null,
                    getString(if (standby) R.string.hey_helm_stop else R.string.call_hang_up),
                    stop,
                ).build(),
            )
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
