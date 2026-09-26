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
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.HelmLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
        private const val ACTION_HANG_UP = "com.potatomotato.helm.call.HANG_UP"
        private const val ACTION_MUTE = "com.potatomotato.helm.call.MUTE"
        private const val ACTION_ROUTE = "com.potatomotato.helm.call.ROUTE"
        private const val EXTRA_TARGET = "target"
        private const val EXTRA_VALUE = "value"

        private val _call = MutableStateFlow<Call?>(null)

        /** The live call, or null. Process-scoped: there is at most one call. */
        val call: StateFlow<Call?> = _call.asStateFlow()

        fun start(context: Context, targetId: String) {
            context.startForegroundService(command(context, ACTION_START).putExtra(EXTRA_TARGET, targetId))
        }

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

    /** begin() ran: the mode, focus and route are ours to restore. */
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
        if (action == ACTION_START) {
            // Foreground FIRST, whatever happens next: a service started with
            // startForegroundService that never calls startForeground crashes.
            // A live call keeps its own target; a second START only rejoins it.
            val target = targetId ?: intent.getStringExtra(EXTRA_TARGET)
            startForegroundWith(target)
            if (target == null) stopSelf() else if (call == null) begin(target)
            return START_NOT_STICKY
        }
        // Any other command with no live call would start a ghost service and
        // touch the audio stack for nothing.
        if (call == null) {
            stopSelf()
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
        active = true
        HelmLog.i(HelmLog.UI, "voice call starting")

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
            stopSelf()
            return
        }
        audio.registerAudioDeviceCallback(devices, main)
        applyRoute(null)

        val client = HelmPairing.client
        val call = CallController(
            speech = AndroidSpeechEngine(this),
            tts = AndroidTtsEngine(this),
            send = { text -> client.sendChat(target, text) },
            sendFailedLine = getString(R.string.call_send_failed),
        )
        controller = call

        val feed = CallFeed(client.chats.thread(target))
        scope.launch {
            client.chats.threads.map { it[target].orEmpty() }.distinctUntilChanged().collect { thread ->
                val events = feed.next(thread)
                events.replies.forEach(call::onReply)
                repeat(events.failures) { call.onSendFailed() }
            }
        }
        scope.launch {
            call.state.collect { state ->
                publish(state)
                if (state.phase == CallPhase.Ended) stopSelf()
            }
        }
        call.start()
    }

    override fun onDestroy() {
        controller?.hangUp()
        controller = null
        scope.cancel()
        // Only undo what begin() did: a service that never began must not
        // reset the mode or the route out from under a real phone call.
        if (active) {
            runCatching { audio.unregisterAudioDeviceCallback(devices) }
            releaseRoute()
            focus?.let(audio::abandonAudioFocusRequest)
            audio.mode = savedMode
            HelmLog.i(HelmLog.UI, "voice call ended, audio mode restored")
        }
        _call.value = null
        super.onDestroy()
    }

    /** Losing focus — a GSM call, another app's call — ends ours. */
    private fun onFocusChange(change: Int) {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            HelmLog.i(HelmLog.UI, "voice call lost audio focus ($change), hanging up")
            controller?.hangUp()
        }
    }

    private fun publish(state: CallState = controller?.state?.value ?: CallState()) {
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

    private fun startForegroundWith(target: String?) {
        val name = target?.let { HelmPairing.client.sessions.find(it)?.name ?: it }.orEmpty()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUp = PendingIntent.getService(
            this, 1, command(this, ACTION_HANG_UP), PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.call_helm))
            .setContentText(getString(R.string.call_notification_text, name))
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.call_hang_up), hangUp).build())
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
