package com.potatomotato.helm.save

import android.content.Context
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

/** Stores a ComfyUI image opened for preview without adding it to user Downloads. */
class AndroidAttachmentPreviews(context: Context) {
    private val appContext = context.applicationContext

    @Throws(IOException::class)
    fun save(filename: String, mimeType: String, bytes: ByteArray): SavedFile {
        val directory = File(appContext.cacheDir, PREVIEW_DIRECTORY)
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw IOException("Could not create image preview cache")
        }
        val safeName = filename.substringAfterLast('/').substringAfterLast('\\')
            .ifBlank { "image" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
        val file = File(directory, "${System.nanoTime()}-$safeName")
        file.outputStream().use { it.write(bytes) }
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", file)
        return SavedFile("Temporary preview", uri.toString())
    }

    private companion object {
        const val PREVIEW_DIRECTORY = "comfy-previews"
    }
}
