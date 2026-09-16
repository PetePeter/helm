package com.potatomotato.helm

import android.app.Application
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.AndroidLogSink
import com.potatomotato.helm.log.FileLogSink
import com.potatomotato.helm.log.HelmLog
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
