package com.potatomotato.helm.save

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import java.io.IOException

/**
 * The one place this app writes into the user-visible Downloads folder.
 *
 * API 29+ only, because that is when `MediaStore.Downloads` appeared; below it
 * each caller keeps its own permission-free fallback. No storage permission is
 * needed for files this app itself contributes, which is why the manifest asks
 * for none.
 *
 * Two callers with OPPOSITE collision policies share this: an artifact must
 * never overwrite a previous download, a log export must always replace the last
 * one. The policy is the argument; the pending-row dance is what is shared.
 */
@RequiresApi(Build.VERSION_CODES.Q)
internal object MediaStoreDownloads {

    /**
     * Write [bytes] as [filename] and return the user-facing location.
     *
     * With [replaceExisting] the rows already using that name are removed first,
     * so the name the user is told is the name they get. Without it MediaStore
     * is free to disambiguate, and the name it settled on is read back.
     */
    @Throws(IOException::class)
    fun write(
        context: Context,
        filename: String,
        mimeType: String,
        bytes: ByteArray,
        replaceExisting: Boolean,
    ): String {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI

        if (replaceExisting) {
            try {
                resolver.delete(
                    collection,
                    "${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
                    arrayOf(filename),
                )
            } catch (_: Exception) {
                // Nothing to replace, or the phone would not let us. Either way
                // the insert below still produces a file; it may be the
                // disambiguated name, which the read-back reports honestly.
            }
        }

        val details = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            // Pending until the bytes are in: a crash halfway must not leave a
            // zero-byte file the file manager shows as real.
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, details)
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
}
