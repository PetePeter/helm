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
     * Write the bytes to the device's storage and return where the user will
     * find the file ("Downloads/Report.md"), phrased for the Save row to show.
     * Throws when the file cannot be written; the caller turns that into the
     * failure the row reads.
     */
    @Throws(Exception::class)
    fun save(filename: String, mimeType: String, bytes: ByteArray): String
}
