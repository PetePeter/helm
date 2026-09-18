package com.potatomotato.helm.save

/**
 * The naming half of the legacy download path: when the destination folder
 * already holds a file of that name, a second save must suffix rather than
 * overwrite. MediaStore de-duplicates by itself on API 29+; this is the
 * phone-side rule for the folder this app owns. Pure so it tests on the JVM.
 */
object FileNames {

    /** A name nothing in the folder holds is used exactly as asked for. */
    fun disambiguated(existing: Set<String>, wanted: String): String =
        suffixed(wanted, firstFreeAttempt(existing, wanted))

    /**
     * The lowest attempt number whose spelling of [wanted] is free — 1 when the
     * name itself is.
     *
     * Separate from [disambiguated] because the MediaStore path needs the NUMBER:
     * it picks a name from what the folder holds, then keeps claiming upwards
     * from there when the insert is renamed under it. Resuming from the number
     * rather than from the chosen name is what stops `photo (2) (2).jpg`.
     */
    fun firstFreeAttempt(existing: Set<String>, wanted: String): Int {
        var attempt = 1
        while (suffixed(wanted, attempt) in existing) attempt += 1
        return attempt
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
