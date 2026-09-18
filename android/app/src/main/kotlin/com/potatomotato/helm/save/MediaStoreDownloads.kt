package com.potatomotato.helm.save

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import java.io.IOException

/**
 * The one place this app writes into the user-visible Downloads folder — and
 * always into [DownloadFolder] inside it, never loose among the browser's files.
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
     * Write [bytes] as [filename] into `Downloads/Helm` and say where they landed.
     *
     * With [replaceExisting] the rows already using that name IN OUR FOLDER are
     * removed first, so the name the user is told is the name they get. The scope
     * matters: an unscoped delete-by-name would take out a same-named file this
     * app contributed to Downloads itself.
     *
     * WITHOUT it the name is CHOSEN, then CLAIMED, and the two steps close
     * different holes:
     *
     *  - CHOSEN by asking the folder what it already holds. This is only sound
     *    because the folder is ours: under scoped storage the query returns what
     *    this app contributed, and in `Download/Helm` that is everything. Back
     *    when we wrote loose into Downloads the query was blind to the browser's
     *    files, which is why this step did not exist — and why de-collision was
     *    unreliable in practice.
     *  - CLAIMED by inserting and reading the name back, because MediaStore may
     *    still rename us (a row this app no longer owns, a file the query cannot
     *    see). It de-duplicates by appending after the WHOLE display name —
     *    `photo.jpg (1)` — which no viewer, installer or share sheet reads as a
     *    jpg at all. A read-back that disagrees means the name is taken: the
     *    empty pending row is dropped and the next `photo (2).jpg` spelling is
     *    tried. No bytes are written until the name agrees, so a losing attempt
     *    costs one insert and one delete.
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
        val relativePath = DownloadFolder.relativePath(Environment.DIRECTORY_DOWNLOADS)

        if (replaceExisting) {
            try {
                resolver.delete(
                    collection,
                    "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND " +
                        "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                    arrayOf(filename, "$relativePath%"),
                )
            } catch (_: Exception) {
                // Nothing to replace, or the phone would not let us. Either way
                // the insert below still produces a file; it may be the
                // disambiguated name, which the read-back reports honestly.
            }
        }

        // A replacing caller wants its one fixed name back, so it skips the
        // choosing step entirely — suffixing there would grow the numbered pile
        // the flag exists to avoid.
        val from = if (replaceExisting) {
            1
        } else {
            FileNames.firstFreeAttempt(namesInFolder(resolver, collection, relativePath), filename)
        }

        val claim = claimName(resolver, collection, relativePath, filename, mimeType, replaceExisting, from)
        try {
            resolver.openOutputStream(claim.uri)?.use { it.write(bytes) }
                ?: throw IOException("The phone would not open the file for writing")
            val released = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(claim.uri, released, null, null)
            // Read the name back ONCE MORE after publishing: some phones settle
            // the de-duplication at publish time rather than at insert, and the
            // location we report has to be the one the user will actually find.
            val settled = displayName(resolver, claim.uri) ?: claim.name
            return SavedFile(DownloadFolder.location(settled), claim.uri.toString())
        } catch (error: Exception) {
            // A half-written pending row is invisible clutter the file manager
            // keeps showing; clean it up before surfacing the failure.
            discard(resolver, claim.uri)
            throw error
        }
    }

    /**
     * Every display name already in our folder.
     *
     * Failure is an EMPTY set, not an exception: an unreadable folder must not
     * stop a save. The claim loop below is the backstop for whatever this misses.
     */
    private fun namesInFolder(
        resolver: ContentResolver,
        collection: Uri,
        relativePath: String,
    ): Set<String> = try {
        resolver.query(
            collection,
            arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
            "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
            arrayOf("$relativePath%"),
            null,
        )?.use { cursor ->
            buildSet {
                while (cursor.moveToNext()) cursor.getString(0)?.let { add(it) }
            }
        } ?: emptySet()
    } catch (_: Exception) {
        emptySet()
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
        relativePath: String,
        filename: String,
        mimeType: String,
        replaceExisting: Boolean,
        from: Int,
    ): Claim {
        var attempt = from
        while (true) {
            val wanted = FileNames.suffixed(filename, attempt)
            val details = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, wanted)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                // Every caller, one folder. MediaStore creates it on first write.
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                // Pending until the bytes are in: a crash halfway must not leave
                // a zero-byte file the file manager shows as real.
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(collection, details)
                ?: throw IOException("The phone refused a new file in Downloads")

            val settled = displayName(resolver, uri) ?: wanted
            // The cap counts from where the folder scan left off, not from 1: a
            // folder that legitimately holds thirty copies must still be able to
            // take a thirty-first.
            if (replaceExisting || settled == wanted || attempt >= from + MAX_NAME_ATTEMPTS) {
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
