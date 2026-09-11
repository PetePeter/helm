package com.potatomotato.helm.ui.theme

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The design system only holds if colour is declared in exactly one place.
 *
 * This is the one thing about the theme worth asserting: "Bg is black" is a
 * constant equalling itself, but a screen quietly reintroducing `Color(0xFF...)`
 * is a real regression that nothing else catches and that no reviewer reliably
 * spots. It is how a design system dies — one screen at a time.
 *
 * Scope is Kotlin sources under src/main, excluding the theme package itself.
 */
class NoRawColorLiteralTest {

    /**
     * Both ways a screen can conjure a colour: a constructed literal
     * (`Color(0xFF...)`, `Color(1f, 0f, 0f)`) and a Compose built-in
     * (`Color.White`). A bare hex is NOT enough on its own — the BLE framing
     * code legitimately discusses `0xffffffff` in its comments.
     */
    private val rawColor = Regex("""\bColor\s*\(\s*[0-9]|\bColor\.[A-Z]""")

    @Test
    fun `no Compose source outside the theme package declares a raw colour`() {
        val root = File(
            System.getProperty("helm.android.src.dir")
                ?: error("helm.android.src.dir is not set; see app/build.gradle.kts"),
        )
        assertTrue("source root not found: $root", root.isDirectory)

        val offenders = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filterNot { it.toRelativeString(root).replace('\\', '/').startsWith("com/potatomotato/helm/ui/theme/") }
            .flatMap { file ->
                file.readLines().withIndex()
                    .filter { (_, line) -> rawColor.containsMatchIn(line) }
                    .map { (index, line) -> "${file.toRelativeString(root)}:${index + 1}  ${line.trim()}" }
            }
            .toList()

        assertTrue(
            "Raw colour literals outside ui/theme. Use HelmColors instead:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }
}
