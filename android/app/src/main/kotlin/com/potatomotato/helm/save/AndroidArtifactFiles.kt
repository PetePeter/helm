package com.potatomotato.helm.save

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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
 */
class AndroidArtifactFiles(private val context: Context) : ArtifactFiles {

    @Throws(IOException::class)
    override fun save(filename: String, mimeType: String, bytes: ByteArray): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveToDownloads(filename, mimeType, bytes)
        } else {
            saveToAppFolder(filename, bytes)
        }

    /** The user-visible Downloads folder. A collision is MediaStore's problem. */
    @Throws(IOException::class)
    private fun saveToDownloads(filename: String, mimeType: String, bytes: ByteArray): String {
        val resolver = context.contentResolver
        val details = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            // Pending until the bytes are in: a crash halfway must not leave a
            // zero-byte file the file manager shows as real.
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, details)
            ?: throw IOException("The phone refused a new file in Downloads")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IOException("The phone would not open the file for writing")
            val released = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, released, null, null)
            // MediaStore may have renamed the file to dodge a collision; the
            // name it settled on is the one the user will look for.
            val settled = resolver
                .query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
                ?: filename
            return "Downloads/$settled"
        } catch (error: Exception) {
            // A half-written pending row is invisible clutter the file manager
            // keeps showing; clean it up before surfacing the failure.
            try {
                resolver.delete(uri, null, null)
            } catch (_: Exception) {
                // The row is already gone — the failure to report is the write's.
            }
            throw error
        }
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
