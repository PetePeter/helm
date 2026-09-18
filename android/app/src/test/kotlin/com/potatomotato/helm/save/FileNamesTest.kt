package com.potatomotato.helm.save

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The naming half of the legacy download path: when the destination folder
 * already holds a file of that name, the second save must suffix rather than
 * overwrite. MediaStore de-duplicates by itself on API 29+; this is the
 * phone-side rule for the folder this app owns.
 */
class FileNamesTest {

    @Test
    fun `a free name is used as it is`() {
        assertEquals("Report.md", FileNames.disambiguated(emptySet(), "Report.md"))
    }

    @Test
    fun `a collision is suffixed inside the extension`() {
        assertEquals("Report (2).md", FileNames.disambiguated(setOf("Report.md"), "Report.md"))
        assertEquals(
            "Report (3).md",
            FileNames.disambiguated(setOf("Report.md", "Report (2).md"), "Report.md"),
        )
    }

    @Test
    fun `a second APK stays installable`() {
        // The bug this closes: MediaStore's own de-duplication appends after the
        // WHOLE display name, so a second download came back as
        // "app-release.apk (1)" — which no installer, file manager or share
        // sheet reads as an APK. MediaStoreDownloads now picks the name through
        // here BEFORE the insert, so the extension stays last.
        assertEquals(
            "app-release (2).apk",
            FileNames.disambiguated(setOf("app-release.apk"), "app-release.apk"),
        )
        assertEquals(
            "app-release (3).apk",
            FileNames.disambiguated(setOf("app-release.apk", "app-release (2).apk"), "app-release.apk"),
        )
    }

    @Test
    fun `an extensionless name is suffixed plainly`() {
        assertEquals("report (2)", FileNames.disambiguated(setOf("report"), "report"))
    }

    @Test
    fun `a leading dot is not an extension`() {
        // ".report" is a dotfile-shaped name; " (2)" belongs after the whole
        // thing, not between the dot and the rest.
        assertEquals(".report (2)", FileNames.disambiguated(setOf(".report"), ".report"))
    }

    @Test
    fun `suffixed numbers the name without consulting a folder`() {
        // MediaStoreDownloads cannot enumerate Downloads under scoped storage —
        // it claims a name by inserting it and retries on a rename — so the
        // numbering has to be derivable from the attempt alone.
        assertEquals("app-release.apk", FileNames.suffixed("app-release.apk", 1))
        assertEquals("app-release (2).apk", FileNames.suffixed("app-release.apk", 2))
        assertEquals("app-release (3).apk", FileNames.suffixed("app-release.apk", 3))
        assertEquals("report (2)", FileNames.suffixed("report", 2))
        assertEquals(".report (2)", FileNames.suffixed(".report", 2))
    }

    @Test
    fun `the first free attempt is where the claim loop starts`() {
        // MediaStoreDownloads picks a name from what the folder holds, then keeps
        // claiming UPWARDS if the insert is renamed under it. Resuming from the
        // number rather than from the chosen name is what stops the second pass
        // producing "chart (2) (2).png".
        assertEquals(1, FileNames.firstFreeAttempt(emptySet(), "chart.png"))
        assertEquals(2, FileNames.firstFreeAttempt(setOf("chart.png"), "chart.png"))
        assertEquals(
            3,
            FileNames.firstFreeAttempt(setOf("chart.png", "chart (2).png"), "chart.png"),
        )
        // A hole in the run is filled rather than skipped past.
        assertEquals(2, FileNames.firstFreeAttempt(setOf("chart.png", "chart (3).png"), "chart.png"))
    }

    @Test
    fun `a download never overwrites a file already in the folder`() {
        // The whole rule in one line: a name the folder holds is not the name the
        // next save gets, and the one it gets keeps its extension.
        val existing = setOf("holiday.jpg", "holiday (2).jpg")

        val chosen = FileNames.disambiguated(existing, "holiday.jpg")

        assertEquals("holiday (3).jpg", chosen)
        assertFalse(chosen in existing)
    }

    @Test
    fun `a case difference is still a different file`() {
        // The target filesystems here are case-insensitive, but the rule reads
        // names literally: report.md and Report.md can coexist on the desktop's
        // side, and guessing otherwise would rename a real file's sibling.
        assertEquals("Report.md", FileNames.disambiguated(setOf("report.md"), "Report.md"))
    }
}
