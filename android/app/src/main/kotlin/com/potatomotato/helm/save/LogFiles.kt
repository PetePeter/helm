package com.potatomotato.helm.save

/**
 * Where an exported log lands on THIS phone.
 *
 * A seam of its own rather than a method on [ArtifactFiles] because the
 * collision policy is the opposite one: an artifact is a document the user is
 * collecting and must never overwrite a previous download, while the log is a
 * single diagnostic snapshot whose older copies are noise. The user asked for
 * overwrite explicitly, and encoding that in the type is what stops a future
 * caller from picking the wrong one.
 */
interface LogFiles {

    /**
     * Write [text] to the device's Downloads under exactly [filename],
     * REPLACING any file already there by that name, and return where the user
     * will find it. Throws when it cannot be written; the caller turns that into
     * the reason it shows.
     */
    @Throws(Exception::class)
    fun overwrite(filename: String, mimeType: String, text: String): String
}
