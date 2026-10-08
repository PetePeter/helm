package com.potatomotato.helm.link

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.potatomotato.helm.ble.LinkScheduler
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * A [LinkScheduler] that still fires when the phone is asleep.
 *
 * WHY not a coroutine delay like every other timer here: the one thing this
 * schedules is [LinkEnergyPolicy] giving up a search, which is what turns the
 * Bluetooth advertiser OFF. A delay only counts while the CPU is awake, and a
 * phone in a pocket is not — so the search would "end" hours late, with the
 * advertiser running fast and loud the whole time. An alarm is the timer the
 * system keeps for a sleeping app.
 *
 * Inexact on purpose (`setAndAllowWhileIdle`): it needs no exact-alarm
 * permission, and a search that ends a few minutes late costs nothing that
 * matters. There is no cancel, matching the interface — a stale action is the
 * caller's to ignore, and [LinkEnergyPolicy] already does.
 */
class AlarmLinkScheduler(context: Context) : LinkScheduler {
    private val app = context.applicationContext
    private val alarms = app.getSystemService(AlarmManager::class.java)
    private val waiting = ConcurrentHashMap<Int, () -> Unit>()
    private val nextId = AtomicInteger()

    init {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                waiting.remove(intent?.getIntExtra(EXTRA_ID, -1))?.invoke()
            }
        }
        // NOT exported: the alarm is this app's own, and nothing else may fire it.
        ContextCompat.registerReceiver(app, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun schedule(delayMs: Long, action: () -> Unit) {
        val id = nextId.incrementAndGet()
        waiting[id] = action
        val fire = PendingIntent.getBroadcast(
            app,
            id,
            Intent(ACTION).setPackage(app.packageName).putExtra(EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE,
        )
        alarms.setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + delayMs,
            fire,
        )
    }

    private companion object {
        const val ACTION = "com.potatomotato.helm.LINK_TIMER"
        const val EXTRA_ID = "id"
    }
}
