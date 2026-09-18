package com.potatomotato.helm.save

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.potatomotato.helm.data.StagedAttachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * The staging half of a phone-authored attachment: a picker's `content://` grant
 * becomes a COPY under this app's cache dir, and the copy — not the grant — is
 * what an upload reads from.
 *
 * WHY A COPY: a picker grant can die under a rotation or a trip through the
 * recents screen, and an upload that cannot re-read its file halfway across a
 * BLE link is worse than one that never started. The cache dir is this app's
 * own, so the stream port [open] cannot be revoked out from under a transfer.
 * Copies are swept on app start below — staging is per-create, not a library.
 *
 * The digest is taken WHILE the copy is written, and it is the whole file's:
 * the desktop verifies it before the attachment exists, so it must describe the
 * exact bytes this phone holds, not the bytes the picker promised.
 */
class AndroidAttachmentStaging(private val context: Context) {

    /**
     * Copy [source] into the cache dir under a fresh name, measuring as it goes.
     * Returns null when the pick cannot be read — a revoked grant, a removed
     * file — which the editor shows as a refused attach, never as a staged chip
     * that will fail later.
     */
    suspend fun stage(source: String, displayName: String?, mimeType: String?): StagedAttachment? =
        withContext(Dispatchers.IO) {
            val uri = Uri.parse(source)
            val filename = sanitize(displayName ?: queryDisplayName(uri) ?: FALLBACK_NAME)
            val dir = File(context.cacheDir, STAGING_DIRECTORY).apply { mkdirs() }
            val copy = File(dir, "${System.nanoTime()}-$filename")
            val digest = MessageDigest.getInstance("SHA-256")
            try {
                val input = context.contentResolver.openInputStream(uri) ?: return@withContext null
                input.use { stream ->
                    var bytes = 0L
                    val buffer = ByteArray(COPY_BUFFER_BYTES)
                    copy.outputStream().use { out ->
                        while (true) {
                            val read = stream.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            bytes += read
                        }
                    }
                    StagedAttachment(
                        key = copy.name,
                        source = source,
                        localPath = copy.absolutePath,
                        filename = filename,
                        mimeType = mimeType ?: contentResolverType(uri),
                        sizeBytes = bytes,
                        sha256 = digest.digest().joinToString("") { "%02x".format(it) },
                    )
                }
            } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
                // An unreadable pick is a refused attach, not a crash — and not
                // a half-written copy left behind to be staged next time.
                copy.delete()
                null
            }
        }

    /**
     * A staged file's bytes, fresh per upload attempt. Null when the copy was
     * swept mid-flight — the chip fails and offers a re-attach.
     */
    fun open(staged: StagedAttachment): InputStream? = try {
        FileInputStream(staged.localPath)
    } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
        null
    }

    /** Take a staged file back off — the chip's ✕. The copy goes with it. */
    fun discard(staged: StagedAttachment) {
        File(staged.localPath).delete()
    }

    private fun contentResolverType(uri: Uri): String? =
        try {
            context.contentResolver.getType(uri)
        } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
            null
        }

    /** The picker's own name for the file, when it keeps one. */
    private fun queryDisplayName(uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
            }
    } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
        null
    }

    /**
     * A filename crosses the wire into a desktop path context, so path pieces
     * are stripped rather than trusted, and an empty result falls back — a
     * header of `""` would be a name no list can render.
     */
    private fun sanitize(candidate: String): String {
        val stripped = candidate.substringAfterLast('/').substringAfterLast('\\').trim()
        return stripped.ifEmpty { FALLBACK_NAME }
    }

    companion object {
        private const val STAGING_DIRECTORY = "artifact-uploads"
        private const val COPY_BUFFER_BYTES = 64 * 1024
        private const val FALLBACK_NAME = "attachment"
    }
}
