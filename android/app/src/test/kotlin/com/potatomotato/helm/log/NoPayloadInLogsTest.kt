package com.potatomotato.helm.log

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The one rule of [HelmLog] — never log a secret or a payload — enforced.
 *
 * WHY a source scan rather than a unit test: "the produced line contains no
 * PSK" can only be asserted for a call site a test knows about, and the risk is
 * entirely in the call sites nobody has written yet. A test that watched one
 * function would report green forever while a new screen interpolated a chat
 * message into a debug line. This scans every call site instead, which is the
 * same idiom the theme already uses to keep colour in one place
 * (`NoRawColorLiteralTest`) and inset handling in one place
 * (`InsetsOwnedByThemeTest`).
 *
 * It mirrors the desktop's rule that the mobile audit stores argument KEY NAMES
 * only. If you need to say something about a payload, say its SIZE, its COUNT
 * or its TYPE.
 */
class NoPayloadInLogsTest {

    /**
     * The things this app actually holds that must never reach logcat: key
     * material, the SAS digits, decrypted application messages, chat text,
     * terminal snapshots and raw chunks. Matched both as a bare identifier and
     * as a property access, so `text` and `record.text` are both caught.
     *
     * Deliberately NOT here: `message`, `reason` and `error`. Those name the
     * diagnostic strings this facility exists to carry, and banning them would
     * ban logging itself.
     */
    private val forbidden = listOf(
        "psk", "sas", "plaintext", "secret", "password", "token",
        "payload", "chunk", "text", "body", "content", "snapshot", "transcript",
        "key", "keyMaterial", "sharedSecret",
    )

    /**
     * Every `$name` / `${a.b.c}` interpolation, captured whole so the rule can
     * be applied to its LAST segment.
     */
    private val interpolation = Regex("""\$\{?([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)""")

    /**
     * The rule is applied to the FINAL path segment, which is what draws the
     * honest line: `${chunk.size}` and `${plaintext.size}` describe a payload
     * and are fine, `${record.text}` and `$psk` ARE the payload and are not.
     * Describe the container; never what is in it.
     */
    private fun offends(expression: String): Boolean {
        val last = expression.substringAfterLast('.')
        return forbidden.any { it.equals(last, ignoreCase = true) }
    }

    @Test
    fun `no log call site interpolates a secret or a payload`() {
        val root = File(
            System.getProperty("helm.android.src.dir")
                ?: error("helm.android.src.dir is not set; see app/build.gradle.kts"),
        )
        assertTrue("source root not found: $root", root.isDirectory)

        val offenders = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            // The facility itself documents the rule it enforces.
            .filterNot { it.toRelativeString(root).replace('\\', '/').startsWith("com/potatomotato/helm/log/") }
            .flatMap { file -> offendersIn(file, root) }
            .toList()

        assertTrue(
            "These log call sites interpolate something that may be a secret or a payload.\n" +
                "Log a size, a count, an id or an error TYPE instead:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }

    private fun offendersIn(file: File, root: File): List<String> {
        val lines = file.readLines()
        val result = mutableListOf<String>()
        lines.forEachIndexed { index, line ->
            if (!line.contains("HelmLog.")) return@forEachIndexed
            val window = lines.subList(index, minOf(index + WINDOW, lines.size))
            window.forEachIndexed { offset, candidate ->
                interpolation.findAll(candidate)
                    .map { it.groupValues[1] }
                    .filter(::offends)
                    .forEach { expression ->
                        result.add(
                            "${file.toRelativeString(root)}:${index + offset + 1}  " +
                                "${candidate.trim()}   [\$$expression]",
                        )
                    }
            }
        }
        return result
    }

    private companion object {
        /**
         * A call can wrap, and the lambda form puts the message on the NEXT
         * line. Three lines past the call covers every formatting used here.
         */
        const val WINDOW = 4
    }
}
