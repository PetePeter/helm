package com.potatomotato.helm.save

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
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
     * WITHOUT it the name is CLAIMED rather than guessed. MediaStore
     * de-duplicates on its own, but it appends after the whole display name — a
     * second `app-release.apk` came back as `app-release.apk (1)`, which no file
     * manager, installer or share sheet reads as an APK at all.
     *
     * Asking the folder what it already holds does not fix that: under scoped
     * storage a query of `MediaStore.Downloads` returns only what THIS app
     * contributed, so a file the browser saved is invisible to us and the
     * collision happens anyway. That was the first attempt, and the bug survived
     * it.
     *
     * So the name is claimed by INSERTING it and reading back what MediaStore
     * settled on. A different name means it renamed us: that empty pending row is
     * deleted and the next spelling is tried. No bytes are written until the
     * name agrees, so a losing attempt costs one insert and one delete.
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

        val claim = claimName(resolver, collection, filename, mimeType, replaceExisting)
        try {
            resolver.openOutputStream(claim.uri)?.use { it.write(bytes) }
                ?: throw IOException("The phone would not open the file for writing")
            val released = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(claim.uri, released, null, null)
            return SavedFile("Downloads/${claim.name}", claim.uri.toString())
        } catch (error: Exception) {
            // A half-written pending row is invisible clutter the file manager
            // keeps showing; clean it up before surfacing the failure.
            discard(resolver, claim.uri)
            throw error
        }
    }

    /** A pending row that holds the name it says it does. */
    private data class Claim(val uri: Uri, val name: String)

    /**
     * Insert until the name we asked for is the name we got, or until the
     * attempts run out.
     *
     * [replaceExisting] callers take the FIRST row whatever it is named: a log
     * export is one file that replaces the last one, and retrying a rename there
     * would grow the numbered pile the flag exists to avoid.
     *
     * The cap matters. A phone whose MediaStore renames for some reason other
     * than a collision would loop forever, and an unbounded loop in a save path
     * is worse than a file with an awkward name — so the last attempt is
     * accepted as-is and reported honestly.
     */
    @Throws(IOException::class)
    private fun claimName(
        resolver: ContentResolver,
        collection: Uri,
        filename: String,
        mimeType: String,
        replaceExisting: Boolean,
    ): Claim {
        var attempt = 1
        while (true) {
            val wanted = FileNames.suffixed(filename, attempt)
            val details = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, wanted)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                // Pending until the bytes are in: a crash halfway must not leave
                // a zero-byte file the file manager shows as real.
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(collection, details)
                ?: throw IOException("The phone refused a new file in Downloads")

            val settled = displayName(resolver, uri) ?: wanted
            if (replaceExisting || settled == wanted || attempt >= MAX_NAME_ATTEMPTS) {
                return Claim(uri, settled)
            }

            // MediaStore renamed us, which means the name is taken. Drop the
            // empty row — no bytes have been written — and try the next one.
            discard(resolver, uri)
            attempt += 1
        }
    }

    /**
     * How many spellings to try before accepting whatever MediaStore gives.
     * Twenty copies of one file is already an unusual folder; a loop that never
     * ends is a worse outcome than an awkward name.
     */
    private const val MAX_NAME_ATTEMPTS = 20

    /** The row's display name, or null when it cannot be read. */
    private fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (_: Exception) {
        null
    }

    /** Remove a row we are abandoning. Never throws: the caller has its own failure. */
    private fun discard(resolver: ContentResolver, uri: Uri) {
        try {
            resolver.delete(uri, null, null)
        } catch (_: Exception) {
            // The row is already gone — the failure to report is the caller's.
        }
    }
}
