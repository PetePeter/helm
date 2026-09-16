package com.potatomotato.helm.save

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.io.IOException

/**
 * The real sink for an exported log: one file in Downloads, replaced each time.
 *
 * Overwriting is the point. The export is a diagnostic snapshot the user takes
 * when something looks wrong and hands over; a folder accumulating
 * helm-log(4).txt is worse than useless, because nobody can tell which one is
 * the run being discussed.
 *
 * Storage rules are the same as [AndroidArtifactFiles] and for the same reason:
 * no permission is needed for what this app contributes to Downloads on API 29+,
 * and below that the app's own external folder is the permission-free fallback.
 */
class AndroidLogFiles(private val context: Context) : LogFiles {

    @Throws(IOException::class)
    override fun overwrite(filename: String, mimeType: String, text: String): String {
        val bytes = text.toByteArray()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStoreDownloads.write(context, filename, mimeType, bytes, replaceExisting = true)
        } else {
            writeToAppFolder(filename, bytes)
        }
    }

    /** Same folder the artifact fallback uses — here the name is simply reused. */
    @Throws(IOException::class)
    private fun writeToAppFolder(filename: String, bytes: ByteArray): String {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IOException("No storage on the phone to write into")
        val file = File(dir, filename)
        file.writeBytes(bytes)
        return "${file.name} (in Helm's app folder)"
    }
}
