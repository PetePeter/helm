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
        var attempt = 1
        var candidate = wanted
        while (candidate in existing) {
            attempt += 1
            candidate = suffixed(wanted, attempt)
        }
        return candidate
    }

    /**
     * The [attempt]-th spelling of [wanted]: `Report.md` at 2 is `Report (2).md`.
     * Attempt 1 is the name itself.
     *
     * The suffix goes INSIDE the extension, which is the whole point. A name
     * suffixed after the extension — `Report.md (2)` — is what MediaStore
     * produces on its own, and nothing downstream reads it as a `.md` at all:
     * an APK named that way will not install.
     *
     * Split on the LAST dot, and only when something precedes it — `.report` is
     * a dotfile-shaped name, not an extension, so its suffix goes after the
     * whole thing.
     */
    fun suffixed(wanted: String, attempt: Int): String {
        if (attempt <= 1) return wanted
        val dot = wanted.lastIndexOf('.')
        val hasExtension = dot > 0
        val base = if (hasExtension) wanted.substring(0, dot) else wanted
        val extension = if (hasExtension) wanted.substring(dot) else ""
        return "$base ($attempt)$extension"
    }
}
