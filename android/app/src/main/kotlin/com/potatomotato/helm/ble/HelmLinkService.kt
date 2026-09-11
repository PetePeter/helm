package com.potatomotato.helm.ble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.R

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
 * [BleLinkSession].
 */
class HelmLinkService : Service() {

    companion object {
        private const val TAG = "HelmLinkService"
        private const val CHANNEL_ID = "helm_link"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, HelmLinkService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, HelmLinkService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var gattServer: GattServer? = null
    private var session: BleLinkSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForegroundWith(LinkState.Disconnected)

        val server = GattServer(this) { Log.i(TAG, it) }
        val link = BleLinkSession(
            peripheral = server,
            scheduler = { delayMs, action -> handler.postDelayed(action, delayMs) },
            onMessage = HelmLink::publishInbound,
            onStateChange = { state ->
                HelmLink.publishState(state)
                startForegroundWith(state)
            },
            log = { Log.i(TAG, it) },
        )
        server.session = link
        gattServer = server
        session = link

        if (server.open()) {
            HelmLink.sender = link::send
            link.start()
        } else {
            // No radio, no permission, or no peripheral support: stay up with an
            // honest notification rather than crash-looping the service.
            Log.w(TAG, "could not open the GATT server; the link stays down")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        HelmLink.detach()
        session?.stop()
        gattServer?.close()
        handler.removeCallbacksAndMessages(null)
        session = null
        gattServer = null
        super.onDestroy()
    }

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
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
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
