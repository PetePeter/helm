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
 * It also holds "Hey Helm" standby ([Standby]): the same controller and the
 * same microphone service, but none of the call's audio takeover — standby runs
 * for hours, so it must not hold focus or the communication mode while music
 * plays; its voice goes out as the ASSISTANT stream instead. A call started
 * during standby replaces it, and standby resumes when the call ends if the
 * switch is still on.
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
        private const val STANDBY_TIMEOUT_MS = 120_000L
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
    private var controller: CallController? = null
    private var targetId: String? = null

    /** The live controller is "Hey Helm" standby rather than a call. */
    private var standby = false

    /** Standby's target while a call holds the service, so standby can come back. */
    private var standbyTarget: String? = null

    /** The live controller's collectors; cancelled when it is swapped out. */
    private var job: Job? = null
    private var tone: ToneGenerator? = null

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
            val target = (if (standby) null else targetId) ?: intent.getStringExtra(EXTRA_TARGET)
            startForegroundWith(target, standby = false)
            when {
                target == null -> if (call == null) stopSelf()
                call == null -> begin(target, standby = false)
                standby -> {
                    standbyTarget = targetId
                    endCurrent()
                    begin(target, standby = false)
                }
            }
            return START_NOT_STICKY
        }
        if (action == ACTION_STANDBY) {
            val target = intent.getStringExtra(EXTRA_TARGET)
            if (call != null && !standby) {
                // A live call wins; standby comes back when it ends.
                startForegroundWith(targetId, standby = false)
                standbyTarget = target
                return START_NOT_STICKY
            }
            startForegroundWith(target, standby = true)
            when {
                target == null -> if (call == null) stopSelf()
                call == null -> begin(target, standby = true)
                target != targetId -> {
                    endCurrent()
                    begin(target, standby = true)
                }
            }
            return START_NOT_STICKY
        }
        // The notification's Stop is the switch: standby must not come back on
        // the next app open after the user silenced it. The app's own stops
        // (switch off, no target) leave the switch as it is.
        if (action == ACTION_STOP_STANDBY && intent.getBooleanExtra(EXTRA_VALUE, false)) {
            HeyHelmSetting.set(false)
        }
        // Any other command with no live call would start a ghost service and
        // touch the audio stack for nothing.
        if (call == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (action) {
            ACTION_HANG_UP -> call.hangUp()
            // During a call, switching standby off only cancels its comeback.
            ACTION_STOP_STANDBY -> if (standby) call.hangUp() else standbyTarget = null
            ACTION_MUTE -> call.setMuted(intent.getBooleanExtra(EXTRA_VALUE, false))
            ACTION_ROUTE -> intent.getStringExtra(EXTRA_VALUE)
                ?.let { name -> AudioRoute.entries.firstOrNull { it.name == name } }
                ?.let(::applyRoute)
        }
        // A killed call is not resumed behind the user's back.
        return START_NOT_STICKY
    }

    private fun begin(target: String, standby: Boolean) {
        targetId = target
        this.standby = standby
        _standingBy.value = standby
        HelmLog.i(HelmLog.UI, if (standby) "hey helm standby starting" else "voice call starting")
        if (!standby && !takeAudio()) {
            stopSelf()
            return
        }

        val client = HelmPairing.client
        val call = CallController(
            speech = AndroidSpeechEngine(this),
            tts = AndroidTtsEngine(
                this,
                if (standby) AudioAttributes.USAGE_ASSISTANT else AudioAttributes.USAGE_VOICE_COMMUNICATION,
            ),
            send = { text -> client.sendChat(target, text) },
            sendFailedLine = getString(R.string.call_send_failed),
            standby = if (standby) standbyConfig() else null,
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
                    if (state.phase == CallPhase.Ended) ended(state)
                }
            }
        }
        call.start()
    }

    private fun standbyConfig() = Standby(
        onWake = ::cue,
        yesLine = getString(R.string.hey_helm_yes),
        stillWaitingLine = getString(R.string.hey_helm_still_waiting),
        timeoutMs = STANDBY_TIMEOUT_MS,
        schedule = { delayMs, action ->
            val run = Runnable(action)
            main.postDelayed(run, delayMs)
            ({ main.removeCallbacks(run) })
        },
    )

    /** The short beep that says "heard you" before the question goes. */
    private fun cue() {
        val generator = tone
            ?: runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, CUE_VOLUME) }.getOrNull()
            ?: return
        tone = generator
        generator.startTone(ToneGenerator.TONE_PROP_ACK, CUE_MS)
    }

    /**
     * The controller ended. A call that ends with the switch still on goes back
     * to standby rather than leaving the phone deaf; anything else stops.
     */
    private fun ended(state: CallState) {
        val resume = standbyTarget ?: targetId
        standbyTarget = null
        // Standby killed by a fatal recogniser error (no mic permission, no
        // recognition service) is off; the switch must not claim otherwise.
        if (standby && state.error != null) HeyHelmSetting.set(false)
        if (standby || !HeyHelmSetting.enabled.value || resume == null) {
            stopSelf()
            return
        }
        endCurrent()
        releaseAudio()
        startForegroundWith(resume, standby = true)
        begin(resume, standby = true)
    }

    /** Swap the live controller out without stopping the service. */
    private fun endCurrent() {
        job?.cancel()
        job = null
        controller?.hangUp()
        controller = null
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
