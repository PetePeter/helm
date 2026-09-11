package com.potatomotato.helm.log

import android.util.Log
import com.potatomotato.helm.BuildConfig

/**
 * HelmLog — the app's one logging facility.
 *
 * WHY it exists: the first real end-to-end run against a radio produced two
 * defects and no evidence, because the app had eight `Log.` calls in three
 * files and `adb logcat | grep -i helm` printed nothing. A phone that cannot
 * say what it is doing costs a round trip through the user's hardware for every
 * question.
 *
 * WHY a sink rather than calls straight to [Log]: most of this app is
 * deliberately free of Android types — [com.potatomotato.helm.link.HelmClient],
 * the repositories and the codec all test on the JVM against fakes, and
 * `android.util.Log` is an unmocked stub there that returns 0 and writes
 * nowhere. Routing through [sink] means those layers can log without importing
 * Android and without a second mechanism existing for them.
 *
 * WHY no Timber or any other dependency: a tag, a level and a string is the
 * whole requirement. The APK is already ~9.5 MB with R8 off.
 *
 * ## The one rule
 *
 * **NEVER log a secret or a payload.** No PSK, no key material, no SAS digits,
 * no plaintext message body, no session content, no chunk contents. Log ids,
 * sizes, counts, states and error TYPES. This mirrors the desktop's rule that
 * the mobile audit stores argument KEY NAMES only, and it is enforced rather
 * than promised: `NoPayloadInLogsTest` scans every call site in `src/main`.
 */
object HelmLog {

    // ---- tags -------------------------------------------------------------
    //
    // One per subsystem, so `adb logcat -s HelmBle:V HelmClient:V` is a usable
    // filter. Android truncates a tag past 23 characters; all of these are far
    // inside that.

    /** Radio, advertising, GATT callbacks, framing. */
    const val BLE = "HelmBle"

    /** Handshake and channel state. States only — never key material. */
    const val CHANNEL = "HelmChannel"

    /** Envelope encode/decode and reassembly. */
    const val WIRE = "HelmWire"

    /** Calls, correlation and outcomes. */
    const val CLIENT = "HelmClient"

    /** What the repositories did with a snapshot. */
    const val DATA = "HelmData"

    /** Screens and navigation. */
    const val UI = "HelmUi"

    /** Alert routing and notifications. */
    const val NOTIFY = "HelmNotify"

    /**
     * Whether verbose and debug are emitted at all.
     *
     * Defaults from [BuildConfig.DEBUG] so a release build is quiet without
     * anyone having to remember. A `var` because tests exercise both branches —
     * that gating is real behaviour and is worth asserting.
     */
    @Volatile
    @JvmStatic
    var debugEnabled: Boolean = BuildConfig.DEBUG

    /** Where lines go. Replaced by tests; [AndroidLogSink] everywhere else. */
    @Volatile
    @JvmStatic
    var sink: LogSink = AndroidLogSink

    /**
     * Flow detail. The lambda is NOT invoked when debug logging is off, so a
     * release build does not pay for the string it will never print.
     */
    fun v(tag: String, message: () -> String) {
        if (debugEnabled) write(LogLevel.VERBOSE, tag, message(), null)
    }

    /** Flow worth seeing while diagnosing. Same gating as [v]. */
    fun d(tag: String, message: () -> String) {
        if (debugEnabled) write(LogLevel.DEBUG, tag, message(), null)
    }

    /** A lifecycle transition worth seeing in a release build. Never gated. */
    fun i(tag: String, message: String) = write(LogLevel.INFO, tag, message, null)

    /** A recoverable anomaly: a refused chunk, a dropped record, a retry. */
    fun w(tag: String, message: String, error: Throwable? = null) =
        write(LogLevel.WARN, tag, message, error)

    /** A real failure. Attach the throwable; its type is the diagnosis. */
    fun e(tag: String, message: String, error: Throwable? = null) =
        write(LogLevel.ERROR, tag, message, error)

    /**
     * A `(String) -> Unit` port for the classes that already take one — the
     * existing seam in [com.potatomotato.helm.ble.BleLinkSession] and
     * [com.potatomotato.helm.ble.GattServer], which tests override. Keeping
     * that port and defaulting it here is what stops a second mechanism from
     * existing alongside this one.
     */
    fun port(tag: String): (String) -> Unit = { message -> i(tag, message) }

    /**
     * Logging must never be the thing that takes the app down. A sink that
     * throws is swallowed in the same spirit as invariant 7's PTY rule.
     */
    private fun write(level: LogLevel, tag: String, message: String, error: Throwable?) {
        try {
            sink.write(level, tag, message, error)
        } catch (_: Throwable) {
            // Nothing sensible to do here, and nowhere to report it to.
        }
    }
}

/** Severity, mapped onto [Log]'s levels by [AndroidLogSink]. */
enum class LogLevel { VERBOSE, DEBUG, INFO, WARN, ERROR }

/** Where a line ends up. The one place an Android type is allowed to appear. */
fun interface LogSink {
    fun write(level: LogLevel, tag: String, message: String, error: Throwable?)
}

/** The real sink: `android.util.Log`, and nothing more. */
object AndroidLogSink : LogSink {
    override fun write(level: LogLevel, tag: String, message: String, error: Throwable?) {
        when (level) {
            LogLevel.VERBOSE -> Log.v(tag, message, error)
            LogLevel.DEBUG -> Log.d(tag, message, error)
            LogLevel.INFO -> Log.i(tag, message, error)
            LogLevel.WARN -> Log.w(tag, message, error)
            LogLevel.ERROR -> Log.e(tag, message, error)
        }
    }
}
