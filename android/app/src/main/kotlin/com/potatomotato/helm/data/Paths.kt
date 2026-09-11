package com.potatomotato.helm.data

/**
 * The last segment of a path, however the desktop wrote it.
 *
 * Helm runs on Windows and reports backslash paths, but the same build talks to
 * a POSIX host over the same wire, so both separators are handled in one place
 * rather than in each screen that shortens a path. A path that is nothing but
 * separators keeps its original text: an empty label says less than a strange one.
 */
fun lastPathSegment(path: String): String =
    path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifEmpty { path }
