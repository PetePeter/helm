package com.potatomotato.helm.log

/** A real sink that keeps what it was given, so gating can be asserted on behaviour. */
class RecordingSink : LogSink {
    data class Line(val level: LogLevel, val tag: String, val message: String, val error: Throwable?)

    val lines = mutableListOf<Line>()

    override fun write(level: LogLevel, tag: String, message: String, error: Throwable?) {
        lines.add(Line(level, tag, message, error))
    }

    fun levels(): List<LogLevel> = lines.map { it.level }
}

/**
 * Install [sink] for the duration of [body] and restore what was there.
 *
 * [HelmLog] is process-scoped because there is one log, so a test that changes
 * it must put it back or it leaks into whatever runs next in the same JVM.
 */
fun <T> withHelmLog(sink: LogSink, debugEnabled: Boolean, body: () -> T): T {
    val previousSink = HelmLog.sink
    val previousDebug = HelmLog.debugEnabled
    HelmLog.sink = sink
    HelmLog.debugEnabled = debugEnabled
    try {
        return body()
    } finally {
        HelmLog.sink = previousSink
        HelmLog.debugEnabled = previousDebug
    }
}
