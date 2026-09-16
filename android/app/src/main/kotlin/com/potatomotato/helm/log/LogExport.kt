package com.potatomotato.helm.log

import com.potatomotato.helm.save.LogFiles

/** How an export ended, in the three ways the user needs told apart. */
sealed interface LogExportResult {

    /** [where] is phrased for a person: "Downloads/helm-log.txt". */
    data class Saved(val where: String) : LogExportResult

    /** Nothing has been logged yet — a different thing from a write that failed. */
    data object Empty : LogExportResult

    /** [reason] is whatever the phone said, never an exception the UI must handle. */
    data class Failed(val reason: String) : LogExportResult
}

/**
 * Turning the log on disk into a file in Downloads.
 *
 * WHY this is a plain function over two seams rather than code in the button:
 * the button is pressed by someone standing somewhere with no cable and no adb,
 * so every branch has to end in something readable. Keeping the decision here
 * means it is asserted on the JVM instead of hoped for on a phone.
 */
object LogExport {

    /**
     * Fixed on purpose: the user asked for the export to REPLACE the last one. A
     * timestamped name would leave a pile in Downloads and never overwrite.
     */
    const val FILENAME = "helm-log.txt"

    const val MIME_TYPE = "text/plain"

    fun export(logs: String, files: LogFiles): LogExportResult {
        if (logs.isBlank()) return LogExportResult.Empty
        return try {
            LogExportResult.Saved(files.overwrite(FILENAME, MIME_TYPE, logs))
        } catch (error: Exception) {
            // A bare message is usually the phone's own wording; an exception
            // with none still has to say something, and its type is the clue.
            LogExportResult.Failed(error.message ?: error.javaClass.simpleName)
        }
    }
}
