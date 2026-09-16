package com.potatomotato.helm.save

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.io.IOException

/**
 * The real sink: a downloaded artifact becomes a file the user can open.
 *
 * API 29+ writes into `MediaStore.Downloads` — the user-visible Downloads
 * folder, which needs NO storage permission for files this app itself
 * contributes. Below 29 that collection does not exist, and the permission-free
 * fallback is the app's own external Download folder, reachable through a file
 * manager even if it is not the system Downloads entry. The manifest gains
 * nothing either way — WRITE_EXTERNAL_STORAGE is not a permission this app
 * should ask a user for just to save a report.
 *
 * An artifact NEVER overwrites a previous download: it is a document the user is
 * collecting, and a second version of a report must not silently eat the first.
 */
class AndroidArtifactFiles(private val context: Context) : ArtifactFiles {

    @Throws(IOException::class)
    override fun save(filename: String, mimeType: String, bytes: ByteArray): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStoreDownloads.write(context, filename, mimeType, bytes, replaceExisting = false)
        } else {
            saveToAppFolder(filename, bytes)
        }

    /** The app's own Download folder; `FileNames` does the de-duplicating. */
    @Throws(IOException::class)
    private fun saveToAppFolder(filename: String, bytes: ByteArray): String {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IOException("No storage on the phone to write into")
        val existing = dir.list()?.toSet() ?: emptySet()
        val file = File(dir, FileNames.disambiguated(existing, filename))
        file.writeBytes(bytes)
        return "${file.name} (in Helm's app folder)"
    }
}
