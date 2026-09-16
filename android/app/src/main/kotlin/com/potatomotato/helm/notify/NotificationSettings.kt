package com.potatomotato.helm.notify

import java.io.File

/**
 * Whether the phone is allowed to buzz at all.
 *
 * ONE master switch rather than one per [AlertKind]: Android already gives the
 * user per-channel control in system settings, and the channels exist precisely
 * so "a session went idle" can be silenced without losing "a session needs you".
 * Rebuilding that inside the app would be a second, worse copy of a control the
 * OS ships — and one the user would have to discover twice. What the OS does NOT
 * give is a switch reachable in one tap from the screen the user is already on,
 * which is what this is for.
 *
 * An interface for the same reason [com.potatomotato.helm.data.PskStore] is one:
 * the decision to honour it belongs to [AlertRouter], which knows no Android.
 */
interface NotificationSettings {
    var enabled: Boolean
}

/** The default until a store is attached, and what tests run against. */
class MemoryNotificationSettings(override var enabled: Boolean = true) : NotificationSettings

/**
 * The setting, on disk.
 *
 * A file rather than SharedPreferences so the thing that ships is the thing the
 * tests exercise — `SharedPreferences` is an unmocked stub on the JVM, and a
 * setting whose PERSISTENCE is the entire point deserves a test that actually
 * writes something. It is one byte; a preferences framework would be ceremony
 * around a boolean.
 */
class FileNotificationSettings(private val directory: File) : NotificationSettings {

    private val file get() = File(directory, FILE_NAME)

    /**
     * Read through rather than cached: the value changes only when the user taps
     * the toggle, and a one-byte read is cheaper than the bug where two live
     * instances disagree about what the user chose.
     *
     * Anything unreadable — missing, half-written, unparsable — reads as the
     * default. "We do not know" must resolve to notifying, because the failure
     * that cannot be noticed is the silent one.
     */
    override var enabled: Boolean
        get() = when (runCatching { file.readText().trim() }.getOrNull()) {
            OFF -> false
            else -> true
        }
        set(value) {
            // Storage that cannot be written costs the setting, not the app —
            // the same rule the log sink follows. The UI calls this from a tap
            // handler; a throw here would be a crash on a button press.
            runCatching {
                if (directory.isDirectory || directory.mkdirs()) {
                    file.writeText(if (value) ON else OFF)
                }
            }
        }

    companion object {
        const val FILE_NAME = "notifications"

        private const val ON = "1"
        private const val OFF = "0"
    }
}
