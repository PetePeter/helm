package com.potatomotato.helm.save

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where this app's saved files go, and what the user is told.
 *
 * Pure by design: the MediaStore half needs a device, but the DECISIONS — which
 * folder, which name, what the line under the row says — do not, and those are
 * the parts that were getting it wrong.
 */
class DownloadFolderTest {

    @Test
    fun `every save lands in one folder of our own`() {
        // The platform's directory is "Download", singular. Ours hangs off it so
        // Helm's files are findable — and so the MediaStore query that picks a
        // free name is looking at a folder only this app writes to.
        assertEquals("Download/Helm", DownloadFolder.relativePath("Download"))
    }

    @Test
    fun `the reported location is the folder the user will go looking in`() {
        // "Downloads" with the s: the platform spells it one way and every file
        // manager the user owns spells it the other.
        assertEquals("Downloads/Helm/chart.png", DownloadFolder.location("chart.png"))
    }

    @Test
    fun `a second file of the same name is reported at its de-collided name`() {
        val chosen = FileNames.disambiguated(setOf("chart.png"), "chart.png")

        // Never an overwrite, and never "chart.png (2)" — the extension has to
        // stay last or nothing on the phone will open it.
        assertEquals("chart (2).png", chosen)
        assertEquals("Downloads/Helm/chart (2).png", DownloadFolder.location(chosen))
    }
}
