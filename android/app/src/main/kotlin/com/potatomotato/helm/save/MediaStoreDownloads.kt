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
     * Write [bytes] as [filename] and say where they landed.
     *
     * With [replaceExisting] the rows already using that name are removed first,
     * so the name the user is told is the name they get.
     *
     * Without it the name is disambiguated HERE, before the insert. MediaStore
     * will happily de-duplicate on its own, but it appends after the whole
     * display name — a second `app-release.apk` came back as
     * `app-release.apk (1)`, which no file manager, installer or share sheet
     * reads as an APK. Choosing the name first means MediaStore never has to
     * rename, so the extension stays where it belongs.
     */
    @Throws(IOException::class)
    fun write(
        context: Context,
        filename: String,
        mimeType: String,
        bytes: ByteArray,
        replaceExisting: Boolean,
    ): SavedFile {
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

        val wanted = if (replaceExisting) filename else FileNames.disambiguated(
            takenNames(resolver, collection),
            filename,
        )

        val details = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, wanted)
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
            // The name is read back regardless: the disambiguation above closes
            // the common case, but another app may have taken the name in the
            // moment between the query and the insert, and what the user is told
            // must be what is actually on the phone.
            val settled = resolver
                .query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
                ?: wanted
            return SavedFile("Downloads/$settled", uri.toString())
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

    /**
     * Display names already in Downloads. An empty set on ANY failure: a query
     * this app is not allowed to make must not stop a save — it only means
     * MediaStore does the renaming, which is where this started, not a lost file.
     */
    private fun takenNames(
        resolver: android.content.ContentResolver,
        collection: android.net.Uri,
    ): Set<String> = try {
        resolver.query(collection, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val names = HashSet<String>(cursor.count)
                while (cursor.moveToNext()) cursor.getString(0)?.let(names::add)
                names
            }
            ?: emptySet()
    } catch (_: Exception) {
        emptySet()
    }
}
