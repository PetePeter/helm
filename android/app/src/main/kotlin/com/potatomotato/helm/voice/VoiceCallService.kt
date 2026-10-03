package com.potatomotato.helm.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.widget.Toast
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.telecom.HelmTelecom
import com.potatomotato.helm.log.HelmLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * VoiceCallService — holds a "Call Helm" call through screen-off.
 *
 * A `microphone` foreground service, because a call that dies when the screen
 * sleeps is not a call. The audio side is the phone-call shape: the mode is
 * MODE_IN_COMMUNICATION for the call's lifetime (and restored after), focus is
 * Telecom's (the call is a Telecom call), and Telecom owns the route. The
 * microphone is [VoskCallMic], one stream open for the whole call.
 *
 * Wiring only. What the call does is [CallController]; the active route comes
 * from Telecom; what counts as a reply is [CallFeed].
 */
class VoiceCallService : Service() {

    /** One live call, as the call screen draws it. */
    data class Call(
        val targetId: String,
        val state: CallState,
        val route: AudioRoute?,
        val routes: Set<AudioRoute>,
    )

    companion object {
        private const val CHANNEL_ID = "helm_call"
        private const val NOTIFICATION_ID = 2
        private const val ACTION_START = "com.potatomotato.helm.call.START"
        private const val ACTION_HANG_UP = "com.potatomotato.helm.call.HANG_UP"
        private const val ACTION_MUTE = "com.potatomotato.helm.call.MUTE"
        private const val ACTION_MIC_MODE = "com.potatomotato.helm.call.MIC_MODE"
        private const val ACTION_PTT_KEY = "com.potatomotato.helm.call.PTT_KEY"
        private const val ACTION_ROUTE = "com.potatomotato.helm.call.ROUTE"
        private const val ACTION_TRANSFER = "com.potatomotato.helm.call.TRANSFER"
        private const val EXTRA_TARGET = "target"
        private const val EXTRA_VALUE = "value"
        private const val EXTRA_OPENING = "opening"
        private const val EXTRA_FROM = "from"
        private const val CUE_VOLUME = 80
        private const val CUE_MS = 150
        /** A backstop only: the lock is released when the call ends or leaves the earpiece. */
        private const val EAR_SENSOR_MAX_MS = 4 * 60 * 60 * 1000L

        private val _call = MutableStateFlow<Call?>(null)

        /** The live call, or null. Process-scoped: there is at most one call. */
        val call: StateFlow<Call?> = _call.asStateFlow()

        /** [opening]: spoken first, for an answered ring (see [CallController.start]). */
        fun start(context: Context, targetId: String, opening: String? = null) {
            context.startForegroundService(
                command(context, ACTION_START).putExtra(EXTRA_TARGET, targetId).putExtra(EXTRA_OPENING, opening),
            )
        }

        fun hangUp(context: Context) = context.startService(command(context, ACTION_HANG_UP))

        fun setMuted(context: Context, muted: Boolean) =
            context.startService(command(context, ACTION_MUTE).putExtra(EXTRA_VALUE, muted))

        fun setMicMode(context: Context, mode: MicMode) =
            context.startService(command(context, ACTION_MIC_MODE).putExtra(EXTRA_VALUE, mode.name))

        fun setPttKeyHeld(context: Context, held: Boolean) =
            context.startService(command(context, ACTION_PTT_KEY).putExtra(EXTRA_VALUE, held))

        fun setRoute(context: Context, route: AudioRoute) =
            context.startService(command(context, ACTION_ROUTE).putExtra(EXTRA_VALUE, route.name))

        /**
         * Hand the live call from [from] to [to], speaking [line]. Only the
         * session holding the call can move it. Checked here so no service is
         * started for a call that is not there, and again in the service, which
         * owns the target.
         */
        fun transfer(context: Context, from: String?, to: String, line: String) {
            if (from == null || _call.value?.targetId != from) {
                HelmLog.i(HelmLog.UI, "call transfer ignored: not from the live call's session")
                return
            }
            context.startService(
                command(context, ACTION_TRANSFER)
                    .putExtra(EXTRA_FROM, from).putExtra(EXTRA_TARGET, to).putExtra(EXTRA_OPENING, line),
            )
        }

        private fun command(context: Context, action: String) =
            Intent(context, VoiceCallService::class.java).setAction(action)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var audio: AudioManager
    /** The live call, or null. */
    private var controller: CallController? = null

    /** The call's target. */
    private var targetId: String? = null

    /** The live controller's collectors; cancelled when it is swapped out. */
    private var job: Job? = null

    /** The target's reply feed; replaced when the call is transferred. */
    private var feedJob: Job? = null
    private var tone: ToneGenerator? = null

    /** takeAudio() ran: the communication mode is ours to restore. */
    private var active = false
    private var savedMode = AudioManager.MODE_NORMAL
    private var route: AudioRoute? = null
    private var routes: Set<AudioRoute> = emptySet()

    /**
     * Screen off whenever something covers the sensor for the whole call, on any
     * route: at the ear, or face down on a stand to save battery. Lifting it wakes
     * the screen; held away, the sensor is clear and the screen stays usable.
     */
    private val earSensor by lazy {
        getSystemService(PowerManager::class.java)
            .takeIf { it.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) }
            ?.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "helm:call-ear")
    }

    private fun syncEarSensor() {
        val lock = earSensor ?: return
        val wanted = controller != null
        if (wanted && !lock.isHeld) lock.acquire(EAR_SENSOR_MAX_MS)
        // WAIT flag: a release while at the ear keeps the screen dark until moved away.
        if (!wanted && lock.isHeld) lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
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
            val target = (if (call != null) targetId else null) ?: intent.getStringExtra(EXTRA_TARGET)
            startForegroundWith(target)
            when {
                target == null -> if (call == null) stopSelf()
                call == null -> begin(target, intent.getStringExtra(EXTRA_OPENING))
            }
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
            ACTION_MIC_MODE -> intent.getStringExtra(EXTRA_VALUE)
                ?.let { name -> MicMode.entries.firstOrNull { it.name == name } }
                ?.let(call::setMicMode)
            ACTION_PTT_KEY -> call.setPttKeyHeld(intent.getBooleanExtra(EXTRA_VALUE, false))
            ACTION_ROUTE -> intent.getStringExtra(EXTRA_VALUE)
                // Not while still connecting: Telecom owns the route once the call is active.
                ?.takeIf { active }
                ?.let { name -> AudioRoute.entries.firstOrNull { it.name == name } }
                ?.let(HelmTelecom::setAudioRoute)
            ACTION_TRANSFER -> intent.getStringExtra(EXTRA_TARGET)
                ?.takeIf { intent.getStringExtra(EXTRA_FROM) == targetId }
                ?.let { to ->
                    retarget(to)
                    intent.getStringExtra(EXTRA_OPENING)?.let(call::onReply)
                }
        }
        // A killed call is not resumed behind the user's back.
        return START_NOT_STICKY
    }

    private fun begin(target: String, opening: String?) {
        targetId = target
        HelmLog.i(HelmLog.UI, "voice call starting")

        val client = HelmPairing.client
        val call = CallController(
            line = line(target),
            micSwitch = micSwitch,
            mic = VoskCallMic(this),
            tts = AndroidTtsEngine(this),
            send = { text ->
                // The instant "heard you": the reply is seconds away, silence reads as deaf.
                cue()
                HelmLog.d(HelmLog.UI) { "call sending ${text.length} chars" }
                targetId?.let { client.sendChat(it, text) } ?: false
            },
            sendFailedLine = getString(R.string.call_send_failed),
        )
        controller = call
        syncEarSensor()

        listen(target)
        job = scope.launch {
            call.state.collect { state ->
                publish(state)
                if (state.phase == CallPhase.Ended) ended(state.refused)
            }
        }
        HelmTelecom.onAudioState = call::syncMute
        HelmTelecom.onRouteState = { current, available ->
            route = current
            routes = available
            publish()
        }
        // An answered ring is a system call already and opens at once, so its
        // audio is taken here; a call the user starts takes it when the system
        // has taken the call (see [line]).
        if (opening != null) takeAudio()
        call.start(opening)
        // An answered ring that really became a call: tell Helm, so it does not
        // ring again in 10 minutes. Only here — a call that never started (no
        // mic grant) leaves the retry armed.
        if (opening != null) client.ringAnswered(target)
    }

    /**
     * Android's call system for the call to [target]. The audio is taken only
     * once the system has the call: one it refuses never opens the microphone.
     */
    private fun line(target: String) = object : CallLine {
        override fun place(answer: (ready: Boolean) -> Unit): CallRefusal? {
            val name = HelmPairing.client.sessions.find(target)?.name.orEmpty()
            return HelmTelecom.place(this@VoiceCallService, target, name) { created ->
                if (created) takeAudio()
                answer(created)
            }
        }

        override fun active() = HelmTelecom.active()

        override fun end() = HelmTelecom.end()
    }

    private val micSwitch = object : MicSwitch {
        override var muted: Boolean
            get() = audio.isMicrophoneMute
            set(value) {
                audio.isMicrophoneMute = value
            }
    }

    /**
     * Speak [target]'s replies on the call. Only lines after this moment: the
     * feed baselines on the thread as it stands, so a transfer never reads out
     * the new session's history.
     */
    private fun listen(target: String) {
        val call = controller ?: return
        val client = HelmPairing.client
        feedJob?.cancel()
        val feed = CallFeed(client.chats.thread(target))
        feedJob = scope.launch {
            client.chats.threads.map { it[target].orEmpty() }.distinctUntilChanged().collect { thread ->
                val events = feed.next(thread)
                if (events.replies.isNotEmpty()) {
                    HelmLog.i(HelmLog.UI, "call target replied ${events.replies.size} line(s); queued to speak")
                }
                events.replies.forEach(call::onReply)
                repeat(events.failures) { call.onSendFailed() }
            }
        }
    }

    /** The call stays up — mic, audio, route — and only who it talks to changes. */
    private fun retarget(to: String) {
        HelmLog.i(HelmLog.UI, "voice call transferred")
        targetId = to
        listen(to)
        startForegroundWith(to)
        publish()
    }

    /** The short beep that says "heard you" before the question goes. */
    private fun cue() {
        val generator = tone
            ?: runCatching { ToneGenerator(AudioManager.STREAM_VOICE_CALL, CUE_VOLUME) }.getOrNull()
            ?: return
        tone = generator
        generator.startTone(ToneGenerator.TONE_PROP_ACK, CUE_MS)
    }

    /** The call ended: free the mic and the audio, and stop. [refused]: it never started, and why. */
    private fun ended(refused: CallRefusal?) {
        refused?.let { Toast.makeText(this, it.messageRes, Toast.LENGTH_LONG).show() }
        endCurrent()
        releaseAudio()
        stopSelf()
    }

    private fun endCurrent() {
        HelmTelecom.onAudioState = null
        HelmTelecom.onRouteState = null
        job?.cancel()
        job = null
        feedJob?.cancel()
        feedJob = null
        val live = controller != null
        controller?.hangUp()
        controller = null
        syncEarSensor()
        if (live) HelmLog.i(HelmLog.UI, "mic released")
        _call.value = null
    }

    /**
     * The call's audio mode. Telecom owns routing and focus for the call, so
     * this service does not request a second focus. A phone call
     * taking over reaches us as Telecom ending ours (HelmConnection.onDisconnect).
     */
    private fun takeAudio() {
        active = true
        savedMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        HelmTelecom.publishAudioRoute()
    }

    /**
     * Only undo what [takeAudio] did: a service that never took the audio must
     * not reset the mode out from under a real phone call.
     */
    private fun releaseAudio() {
        if (!active) return
        active = false
        route = null
        routes = emptySet()
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

    private fun publish(state: CallState = controller?.state?.value ?: CallState()) {
        val target = targetId ?: return
        _call.value = Call(target, state, route, routes)
    }

    private val CallRefusal.messageRes: Int
        get() = when (this) {
            CallRefusal.Busy -> R.string.call_refused_busy
            CallRefusal.Unavailable -> R.string.call_refused_unavailable
        }

    private fun startForegroundWith(target: String?) {
        val name = target?.let { HelmPairing.client.sessions.find(it)?.name ?: it }.orEmpty()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(this, 1, command(this, ACTION_HANG_UP), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.call_helm))
            .setContentText(getString(R.string.call_notification_text, name))
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(null, getString(R.string.call_hang_up), stop).build(),
            )
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
