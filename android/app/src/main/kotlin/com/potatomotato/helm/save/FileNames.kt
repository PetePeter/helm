package com.potatomotato.helm.save

/**
 * The naming half of the legacy download path: when the destination folder
 * already holds a file of that name, a second save must suffix rather than
 * overwrite. MediaStore de-duplicates by itself on API 29+; this is the
 * phone-side rule for the folder this app owns. Pure so it tests on the JVM.
 */
object FileNames {

    /** A name nothing in the folder holds is used exactly as asked for. */
    fun disambiguated(existing: Set<String>, wanted: String): String {
        if (wanted !in existing) return wanted

        // ".report" is a dotfile-shaped name, not an extension to split around,
        // so the suffix goes after the whole thing.
        val dot = wanted.lastIndexOf('.')
        val hasExtension = dot > 0
        val base = if (hasExtension) wanted.substring(0, dot) else wanted
        val extension = if (hasExtension) wanted.substring(dot) else ""

        var candidate = wanted
        var n = 1
        while (candidate in existing) {
            n += 1
            candidate = "$base ($n)$extension"
        }
        return candidate
    }
}
