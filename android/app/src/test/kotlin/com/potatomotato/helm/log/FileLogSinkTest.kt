package com.potatomotato.helm.log

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The file sink is the whole reason the app can be diagnosed offsite, so the
 * properties asserted here are the ones that decide whether there is anything
 * to read when the user finally presses the button: the line lands, it accretes,
 * logcat still gets it, and the file never grows without bound.
 */
class FileLogSinkTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val delegate = RecordingSink()

    private fun sinkIn(directory: File, maxBytes: Long = 64L * 1024L) =
        FileLogSink(directory = directory, delegate = delegate, maxBytesPerFile = maxBytes)

    @Test
    fun `a written line carries its level, tag and message`() {
        val sink = sinkIn(folder.root)

        sink.write(LogLevel.WARN, HelmLog.BLE, "advertising refused", null)

        val text = sink.snapshot()
        assertTrue(text, text.contains("W/${HelmLog.BLE}"))
        assertTrue(text, text.contains("advertising refused"))
    }

    @Test
    fun `lines accrete rather than replacing one another`() {
        val sink = sinkIn(folder.root)

        sink.write(LogLevel.INFO, HelmLog.BLE, "first", null)
        sink.write(LogLevel.INFO, HelmLog.BLE, "second", null)

        val lines = sink.snapshot().trim().lines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].endsWith("first"))
        assertTrue(lines[1].endsWith("second"))
    }

    /**
     * The file is an ADDITION to logcat, never a replacement: a developer with
     * the phone on a cable must keep the stream they already use.
     */
    @Test
    fun `every line still reaches the wrapped sink`() {
        val sink = sinkIn(folder.root)

        sink.write(LogLevel.ERROR, HelmLog.CHANNEL, "handshake failed", null)

        assertEquals(1, delegate.lines.size)
        assertEquals(LogLevel.ERROR, delegate.lines[0].level)
        assertEquals("handshake failed", delegate.lines[0].message)
    }

    /**
     * A throwable's TYPE is the diagnosis — "which exception" is most of the
     * answer when a radio call fails.
     */
    @Test
    fun `a throwable is recorded by type`() {
        val sink = sinkIn(folder.root)

        sink.write(LogLevel.ERROR, HelmLog.BLE, "write failed", IllegalStateException("radio is busy"))

        val text = sink.snapshot()
        assertTrue(text, text.contains("IllegalStateException"))
        assertTrue(text, text.contains("radio is busy"))
    }

    /**
     * THE point of rotating rather than truncating: the moment you want the log
     * is the moment it just got big, and a truncate-at-the-cap sink throws away
     * precisely the history that explains what happened.
     */
    @Test
    fun `rotation keeps the previous file and reads back oldest first`() {
        val sink = sinkIn(folder.root, maxBytes = 512L)
        val rotated = File(folder.root, FileLogSink.PREVIOUS_NAME)

        sink.write(LogLevel.INFO, HelmLog.BLE, "the oldest line", null)
        // Stop at the FIRST rotation: two files are all that is retained, so
        // writing past a second one would drop the oldest line by design.
        var filler = 0
        while (!rotated.isFile && filler < 200) {
            sink.write(LogLevel.INFO, HelmLog.BLE, "filler line number ${filler++}", null)
        }
        assertTrue("the log never rotated", rotated.isFile)
        sink.write(LogLevel.INFO, HelmLog.BLE, "the newest line", null)

        val text = sink.snapshot()
        assertTrue("the rotated-out history was lost", text.contains("the oldest line"))
        assertTrue(text.contains("the newest line"))
        assertTrue(
            "history must read oldest first",
            text.indexOf("the oldest line") < text.indexOf("the newest line"),
        )
    }

    @Test
    fun `the log is bounded at two files however much is written`() {
        val cap = 512L
        val sink = sinkIn(folder.root, maxBytes = cap)

        repeat(500) { sink.write(LogLevel.INFO, HelmLog.BLE, "a line of some length, number $it", null) }

        val onDisk = folder.root.listFiles().orEmpty()
        assertEquals(setOf(FileLogSink.CURRENT_NAME, FileLogSink.PREVIOUS_NAME), onDisk.map { it.name }.toSet())
        // Each file is allowed to overshoot by at most the line that crossed the
        // cap, so the bound is stated with that slack rather than exactly.
        assertTrue(
            "the log grew past its bound: ${onDisk.sumOf { it.length() }}",
            onDisk.sumOf { it.length() } < 2 * cap + 1024,
        )
    }

    /**
     * Logging must never be the thing that takes the app down (HelmLog's own
     * rule). A directory that cannot be created is a real case on a phone with
     * no room left, and it must cost a log line, not a crash.
     */
    @Test
    fun `an unwritable directory costs the line, not the app`() {
        val blocked = File(folder.newFile("not-a-directory"), "logs")
        val sink = sinkIn(blocked)

        sink.write(LogLevel.INFO, HelmLog.BLE, "into the void", null)

        assertEquals("the line should still reach logcat", 1, delegate.lines.size)
        assertEquals("", sink.snapshot())
    }

    @Test
    fun `a snapshot of an empty log is empty rather than a failure`() {
        assertEquals("", sinkIn(folder.newFolder()).snapshot())
    }

}
