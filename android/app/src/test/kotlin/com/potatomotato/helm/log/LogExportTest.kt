package com.potatomotato.helm.log

import com.potatomotato.helm.save.LogFiles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** A real sink that keeps what it was asked to write. */
private class RecordingLogFiles(private val answer: String = "Downloads/helm-log.txt") : LogFiles {
    val written = mutableListOf<Pair<String, String>>()

    override fun overwrite(filename: String, mimeType: String, text: String): String {
        written.add(filename to text)
        return answer
    }
}

/** A sink that cannot write, which is the case the button must survive. */
private class FailingLogFiles(private val error: Exception) : LogFiles {
    override fun overwrite(filename: String, mimeType: String, text: String): String = throw error
}

/**
 * Export exists to be pressed by a user standing somewhere with no cable and no
 * adb. Every branch therefore has to end in something readable — a path or a
 * reason — and never in an exception the button cannot show.
 */
class LogExportTest {

    @Test
    fun `a successful export reports where the file landed`() {
        val files = RecordingLogFiles(answer = "Downloads/helm-log.txt")

        val result = LogExport.export("some logged lines", files)

        assertEquals(LogExportResult.Saved("Downloads/helm-log.txt"), result)
        assertEquals("some logged lines", files.written.single().second)
    }

    /**
     * The name is fixed BECAUSE the user asked for overwrite: a timestamped name
     * would leave a pile of files in Downloads and never replace the last one.
     */
    @Test
    fun `the export always writes the same filename so it replaces the last one`() {
        val files = RecordingLogFiles()

        LogExport.export("first run", files)
        LogExport.export("second run", files)

        assertEquals(listOf(LogExport.FILENAME, LogExport.FILENAME), files.written.map { it.first })
    }

    @Test
    fun `a sink that cannot write becomes a readable reason, not a crash`() {
        val result = LogExport.export("lines", FailingLogFiles(IOException("no room on device")))

        assertEquals(LogExportResult.Failed("no room on device"), result)
    }

    @Test
    fun `a failure with no message of its own still names its type`() {
        val result = LogExport.export("lines", FailingLogFiles(IllegalStateException()))

        val failed = result as LogExportResult.Failed
        assertTrue(failed.reason, failed.reason.contains("IllegalStateException"))
    }

    /**
     * An empty file in Downloads looks like a broken button. Saying "nothing
     * recorded yet" is the honest answer, and it is a different answer from a
     * write that failed.
     */
    @Test
    fun `an empty log is reported as empty and writes nothing`() {
        val files = RecordingLogFiles()

        val result = LogExport.export("   ", files)

        assertEquals(LogExportResult.Empty, result)
        assertTrue(files.written.isEmpty())
    }
}
