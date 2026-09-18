package com.potatomotato.helm.ble

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R
import com.potatomotato.helm.data.TransportPreferences
import com.potatomotato.helm.log.HelmLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * HelmLinkService — keeps the phone advertising while backgrounded or
 * screen-off.
 *
 * WHY a foreground service at all: the entire point of the app is being told
 * something from the kitchen. Android kills a plain background advertiser, so
 * the `connectedDevice` foreground type is the sanctioned way to stay reachable,
 * and the ongoing notification is the honest price of that.
 *
 * This class is wiring only. Everything that decides anything is in
 * [BleLinkSession] and [BleRadioRecovery].
 */
class HelmLinkService : Service() {

    companion object {
        private const val TAG = HelmLog.BLE
        private const val CHANNEL_ID = "helm_link"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_FORCE_PAIRING = "com.potatomotato.helm.FORCE_PAIRING"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, HelmLinkService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, HelmLinkService::class.java))
        }

        fun forcePairingMode(context: Context) {
            context.startService(Intent(context, HelmLinkService::class.java).apply {
                action = ACTION_FORCE_PAIRING
            })
        }
    }

    private val handler = Handler(Looper.getMainLooper())

    /**
     * Lives as long as the service does. Only the transport preference is
     * collected here; everything else in this class is callback-driven.
     */
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var gattServer: GattServer? = null
    private var session: BleLinkSession? = null
    private lateinit var recovery: BleRadioRecovery

    /**
     * The radio being toggled off and on used to leave the peripheral dead until
     * the user reopened the app. All decisions about that live in
     * [BleRadioRecovery]; this receiver only translates broadcasts into its
     * events. Registered on create, unregistered on destroy.
     */
    private val radioReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> recovery.onBluetoothOn()
                BluetoothAdapter.STATE_OFF -> recovery.onBluetoothOff()
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        HelmLog.i(TAG, "the link service is starting")
        createNotificationChannel()
        startForegroundWith(LinkState.Disconnected)

        val server = GattServer(this, HelmLog.port(TAG))
        val link = BleLinkSession(
            peripheral = server,
            scheduler = { delayMs, action -> handler.postDelayed(action, delayMs) },
            onMessage = { message -> HelmLink.publishInbound(RANK_BLE, message) },
            onStateChange = { state ->
                HelmLink.publishState(RANK_BLE, state)
                startForegroundWith(state)
            },
            log = HelmLog.port(TAG),
        )
        server.session = link
        gattServer = server
        session = link
        // Registered UP FRONT so its state reports are never dropped, and so it
        // is already in place to resume the moment a better transport goes away.
        // Attaching is not the same as being connected — see HelmLink.attach.
        HelmLink.attach(RANK_BLE, pending = { link.pendingBytes }, send = link::send)

        recovery = BleRadioRecovery(
            scheduler = { delayMs, action -> handler.postDelayed(action, delayMs) },
            log = HelmLog.port(TAG),
        ).apply {
            bringUp = {
                // Whatever a previous radio incarnation left behind is dead — a
                // Bluetooth off/on cycle tears the GATT server down in the stack.
                server.close()
                try {
                    val opened = server.open()
                    if (opened) {
                        HelmLink.attach(RANK_BLE, pending = { link.pendingBytes }, send = link::send)
                        link.start()
                    }
                    opened
                } catch (e: Exception) {
                    // Boot can land here with a runtime permission the system
                    // has since revoked; that must not crash-loop the service.
                    HelmLog.w(TAG, "opening the GATT server threw ${e.javaClass.simpleName}: ${e.message}")
                    false
                }
            }
            standDown = {
                link.stop()
            }
        }

        registerReceiver(radioReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
        recovery.onBluetoothState(isBluetoothOn())
        // The user's choice is a SECOND gate on the peripheral, alongside the
        // radio's own state — LAN-only means stop advertising, which is where
        // the battery saving actually comes from. Applied before the first
        // attempt so a LAN-only phone never advertises once on the way up.
        recovery.onTransportAllowed(TransportPreferences.preference.value.allowsBluetooth)
        recovery.start()
        serviceScope.launch {
            TransportPreferences.preference
                .map { it.allowsBluetooth }
                .distinctUntilChanged()
                .collect { allowed -> recovery.onTransportAllowed(allowed) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_FORCE_PAIRING) session?.forcePairingMode()
        return START_STICKY
    }

    override fun onDestroy() {
        // Android tearing the service down is the one link-lifecycle event the
        // phone can see and the desktop cannot infer.
        HelmLog.i(TAG, "the link service is being destroyed")
        HelmLink.detach()
        session?.stop()
        gattServer?.close()
        handler.removeCallbacksAndMessages(null)
        serviceScope.cancel()
        runCatching { unregisterReceiver(radioReceiver) }
        session = null
        gattServer = null
        super.onDestroy()
    }

    @SuppressLint("MissingPermission") // Checked by BlePermissions before the service starts.
    private fun isBluetoothOn(): Boolean =
        getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true

    private fun startForegroundWith(state: LinkState) {
        val notification = buildNotification(state)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(state: LinkState): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val text = when (state) {
            LinkState.Linked -> getString(R.string.link_state_linked)
            LinkState.Connecting -> getString(R.string.link_state_connecting)
            LinkState.Advertising -> getString(R.string.link_state_advertising)
            LinkState.Disconnected -> getString(R.string.link_state_disconnected)
        }

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification_helm)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.link_channel_name),
            // LOW: this notification is a status line, not an interruption. The
            // alerts the user actually wants are P-0746's, on their own channel.
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.link_channel_description)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
