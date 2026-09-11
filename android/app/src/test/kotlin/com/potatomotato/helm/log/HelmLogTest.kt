package com.potatomotato.helm.log

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gating is the only part of [HelmLog] with behaviour worth asserting, and
 * it has two properties that both matter in a release build: the line is not
 * emitted, and the string is never BUILT. A gate that still evaluates its
 * argument would keep every concatenation on the hot inbound path.
 */
class HelmLogTest {

    @Test
    fun `debug off suppresses verbose and debug but never the rest`() {
        val sink = RecordingSink()

        withHelmLog(sink, debugEnabled = false) {
            HelmLog.v(HelmLog.BLE) { "flow" }
            HelmLog.d(HelmLog.BLE) { "flow" }
            HelmLog.i(HelmLog.BLE, "lifecycle")
            HelmLog.w(HelmLog.BLE, "anomaly")
            HelmLog.e(HelmLog.BLE, "failure")
        }

        assertEquals(
            listOf(LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR),
            sink.levels(),
        )
    }

    @Test
    fun `debug on emits every level`() {
        val sink = RecordingSink()

        withHelmLog(sink, debugEnabled = true) {
            HelmLog.v(HelmLog.BLE) { "flow" }
            HelmLog.d(HelmLog.BLE) { "flow" }
            HelmLog.i(HelmLog.BLE, "lifecycle")
        }

        assertEquals(
            listOf(LogLevel.VERBOSE, LogLevel.DEBUG, LogLevel.INFO),
            sink.levels(),
        )
    }

    @Test
    fun `a suppressed message is never built`() {
        var built = false

        withHelmLog(RecordingSink(), debugEnabled = false) {
            HelmLog.d(HelmLog.BLE) { built = true; "expensive" }
        }

        assertFalse("the message lambda ran despite debug logging being off", built)
    }

    @Test
    fun `a sink that throws does not take the caller down`() {
        val exploding = LogSink { _, _, _, _ -> throw IllegalStateException("logging is broken") }

        withHelmLog(exploding, debugEnabled = true) {
            HelmLog.i(HelmLog.BLE, "lifecycle")
            HelmLog.e(HelmLog.BLE, "failure", RuntimeException("cause"))
        }
    }

    @Test
    fun `the port adapts the existing one-string log seam onto this facility`() {
        val sink = RecordingSink()

        withHelmLog(sink, debugEnabled = false) {
            HelmLog.port(HelmLog.CHANNEL)("something happened")
        }

        assertEquals(1, sink.lines.size)
        assertEquals(LogLevel.INFO, sink.lines[0].level)
        assertEquals(HelmLog.CHANNEL, sink.lines[0].tag)
        assertTrue(sink.lines[0].message.contains("something happened"))
    }
}
