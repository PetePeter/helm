package com.potatomotato.helm

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.AndroidLogSink
import com.potatomotato.helm.log.FileLogSink
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.operator.OperatorKey
import com.potatomotato.helm.voice.PttKeyReceiver
import java.io.File

/**
 * Process-wide entry point, and the single place process-scoped singletons are
 * started — so no screen or service has to wonder whether it is the first one in.
 */
class HelmApp : Application() {
    override fun onCreate() {
        super.onCreate()
        installFileLogging()
        HelmPairing.init(this)
        trackScreenOff()
        PttKeyReceiver.listen(this)
    }

    /**
     * The Call operator key may ring over the lock screen shortly after the
     * phone was in use (KeyPress.gate). Screen-off is when it locked. Only a
     * dynamic receiver can hear it, which the link service keeps alive.
     */
    private fun trackScreenOff() {
        registerReceiver(
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    OperatorKey.screenOffAt = SystemClock.elapsedRealtime()
                }
            },
            IntentFilter(Intent.ACTION_SCREEN_OFF),
        )
    }

    /**
     * Logging to disk, always, in every build.
     *
     * WHY always rather than behind a toggle: a toggle is off at the moment the
     * thing you needed to see happened. The defect that made this necessary
     * occurred offsite on a release build, and the only evidence was a logcat
     * ring that had already recycled by the time anyone could ask.
     *
     * WHY debug detail is on in release too: at INFO the BLE chunk defect was
     * invisible — the sender logged every chunk as complete. A log that cannot
     * show what actually went over the radio is not worth the storage it costs.
     * The price is the strings `v`/`d` now build on the inbound path, which is
     * bounded by the same MTU the radio already is.
     */
    private fun installFileLogging() {
        HelmLog.debugEnabled = true
        logs = FileLogSink(directory = File(filesDir, LOG_DIRECTORY), delegate = AndroidLogSink)
        HelmLog.sink = logs ?: AndroidLogSink
        HelmLog.i(HelmLog.UI, "Helm ${BuildConfig.VERSION_NAME} starting, file logging on")
    }

    companion object {
        private const val LOG_DIRECTORY = "logs"

        /**
         * The installed file log, for the export button to read.
         *
         * Process-scoped because there is one log — the same reason [HelmLog]
         * itself is an object. Null only before [onCreate], which no screen can
         * observe, and in JVM tests that never build an Application.
         */
        @Volatile
        @JvmStatic
        var logs: FileLogSink? = null
            private set
    }
}
