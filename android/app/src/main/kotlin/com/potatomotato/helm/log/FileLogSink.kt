package com.potatomotato.helm.log

import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * FileLogSink — the log, kept on the phone so it can be read without a cable.
 *
 * WHY it exists: the BLE chunk defect was diagnosed by asking the user to plug
 * the phone in and run `adb logcat`, and the one run that mattered happened
 * offsite where nobody could. logcat is also a ring the system recycles within
 * minutes, so by the time a user reports something the evidence is already gone.
 * A file the app owns survives the walk home.
 *
 * WHY it wraps another sink instead of replacing it: a developer with the phone
 * on a cable keeps the stream they already use. This is an addition.
 *
 * WHY two files rather than one truncated one: the moment the log matters is the
 * moment it just got big, and truncating at the cap throws away exactly the
 * history that explains what happened. Rotating keeps the previous window, and
 * disk stays bounded at two files.
 *
 * The one rule of [HelmLog] applies unchanged: NEVER write a secret or a
 * payload. This class only formats what it is handed, so the rule is enforced
 * where the call sites are (`NoPayloadInLogsTest`) — but a file the user can
 * mail to someone is the reason that rule is not merely tidy.
 */
class FileLogSink(
    private val directory: File,
    private val delegate: LogSink,
    private val maxBytesPerFile: Long = DEFAULT_MAX_BYTES_PER_FILE,
) : LogSink {

    private val lock = Any()

    /** Thread-confined by [lock]: SimpleDateFormat is not safe to share. */
    private val timestamps = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    private val current get() = File(directory, CURRENT_NAME)
    private val previous get() = File(directory, PREVIOUS_NAME)

    override fun write(level: LogLevel, tag: String, message: String, error: Throwable?) {
        // logcat first and outside the lock's failure path: whatever goes wrong
        // with the file, the stream a developer may be watching is unaffected.
        delegate.write(level, tag, message, error)
        val line = format(level, tag, message, error)
        synchronized(lock) {
            try {
                append(line)
            } catch (_: Throwable) {
                // No room, no permission, no storage. Logging is never allowed to
                // be the thing that takes the app down — the line is simply lost,
                // and logcat already has it.
            }
        }
    }

    /**
     * Everything still on disk, oldest first, ready to be exported.
     *
     * Empty when nothing has been written or the directory could not be made:
     * the caller says "nothing recorded yet" rather than writing an empty file.
     */
    fun snapshot(): String = synchronized(lock) {
        try {
            listOf(previous, current)
                .filter { it.isFile }
                .joinToString(separator = "") { it.readText() }
        } catch (_: Throwable) {
            ""
        }
    }

    private fun append(line: String) {
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw IOException("cannot create the log directory")
        }
        // Rotation is checked BEFORE the write, so a file is never allowed to
        // exceed the cap by more than the single line that crossed it.
        if (current.length() >= maxBytesPerFile) {
            previous.delete()
            current.renameTo(previous)
        }
        current.appendText(line)
    }

    private fun format(level: LogLevel, tag: String, message: String, error: Throwable?): String {
        val stamp = timestamps.format(Date())
        val head = "$stamp ${level.initial}/$tag: $message\n"
        // The throwable's TYPE and stack are most of the diagnosis when a radio
        // call fails, so they are kept whole rather than flattened to a message.
        return if (error == null) head else head + error.stackTraceToString().trimEnd() + "\n"
    }

    companion object {
        /** What `snapshot` reads second and every write lands in. */
        const val CURRENT_NAME = "helm.log"

        /** The window before the last rotation; read first. */
        const val PREVIOUS_NAME = "helm.log.1"

        /**
         * 256 KB per file, so the log costs at most half a megabyte of a phone's
         * storage. At the app's normal rate that is several hours of detail,
         * which is far longer than the gap between a user seeing something odd
         * and being asked for the file.
         */
        const val DEFAULT_MAX_BYTES_PER_FILE = 256L * 1024L
    }
}

/** The single letter logcat uses, so a line reads the same in both places. */
private val LogLevel.initial: Char
    get() = when (this) {
        LogLevel.VERBOSE -> 'V'
        LogLevel.DEBUG -> 'D'
        LogLevel.INFO -> 'I'
        LogLevel.WARN -> 'W'
        LogLevel.ERROR -> 'E'
    }
