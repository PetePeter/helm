package com.potatomotato.helm.save

/**
 * The one folder this app writes user-visible files into: `Downloads/Helm`.
 *
 * WHY A SUBFOLDER. Everything this app saves — artifacts, pulled attachments,
 * log exports — used to land loose in Downloads among the browser's files. Two
 * things were wrong with that. For the user, Helm's files were unfindable among
 * hundreds. For the CODE, it made de-collision guesswork: under scoped storage a
 * query of `MediaStore.Downloads` returns only what THIS app contributed, so a
 * name a browser had already taken was invisible and the save collided anyway.
 *
 * A folder only this app writes to turns that query into the truth: everything in
 * `Download/Helm` is ours, so the names we can see ARE the names that exist, and
 * [FileNames.disambiguated] over them is an answer rather than a hope.
 *
 * Pure so it tests on the JVM — the Android constants stay in the caller.
 */
object DownloadFolder {

    /** The folder's name under the platform's Downloads directory. */
    const val NAME = "Helm"

    /**
     * The `RELATIVE_PATH` value for a MediaStore row. [downloadsDir] is
     * `Environment.DIRECTORY_DOWNLOADS` — "Download", singular, which is the
     * platform's spelling and not the one the UI shows.
     */
    fun relativePath(downloadsDir: String): String = "$downloadsDir/$NAME"

    /**
     * What the user is TOLD, which is deliberately the UI's spelling
     * ("Downloads") rather than the platform's ("Download") — the folder they
     * will go looking in is the one their file manager names.
     */
    fun location(displayName: String): String = "Downloads/$NAME/$displayName"
}
