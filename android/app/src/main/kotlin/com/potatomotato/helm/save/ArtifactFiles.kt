package com.potatomotato.helm.save

/**
 * Where a downloaded artifact lands on THIS phone.
 *
 * The interface exists so the repository's save state machine and the UI glue
 * around it stay testable on the JVM without a disk — the same seam
 * `notify.NotificationPort` draws for notifications. The Android implementation
 * is the only one that ships.
 */
interface ArtifactFiles {

    /**
     * Write the bytes to the device's storage and say where they landed.
     * Throws when the file cannot be written; the caller turns that into the
     * failure the row reads.
     */
    @Throws(Exception::class)
    fun save(filename: String, mimeType: String, bytes: ByteArray): SavedFile
}

/**
 * A file that is now on the phone.
 *
 * TWO strings because they answer different questions. [location] is for a
 * person — "Downloads/Report.md", the place they will look. [uri] is for the
 * system: what an `ACTION_VIEW` intent or an image decoder needs to actually
 * open it. Showing the uri would be unreadable; handing the location to an
 * intent would fail. Deliberately plain strings so the layers that pass this
 * around stay free of Android types.
 */
data class SavedFile(val location: String, val uri: String)
