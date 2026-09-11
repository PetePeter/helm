package com.potatomotato.helm.ui.theme

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Window insets are owned by [HelmTheme] and by nothing else.
 *
 * P-0755 was two halves of one mistake. The top inset was consumed NOWHERE, so
 * the app bar painted over the status-bar clock on every screen. The bottom
 * inset was consumed in FIVE separate screens, which only looked correct
 * because five authors each happened to remember. Scattered inset handling is
 * not a fix that held; it is the same bug that has not surfaced yet.
 *
 * Asserting that a particular modifier is present on a particular composable
 * would be a mock-verification test with no value — the real failing test for
 * this defect was a human looking at a phone. What IS worth asserting is the
 * structural rule the fix establishes, because it is exactly the rule a future
 * screen will break, it breaks silently, and no reviewer reliably spots it.
 *
 * Scope is Kotlin sources under src/main, excluding the theme package that
 * legitimately owns the padding.
 */
class InsetsOwnedByThemeTest {

    /**
     * Every Compose modifier that consumes a window inset. `windowInsetsPadding`
     * is the general form and the others are its named shorthands; a screen
     * reaching for any of them is claiming ownership the root already has.
     */
    private val insetModifier = Regex(
        """\b(safeDrawingPadding|safeContentPadding|systemBarsPadding|statusBarsPadding""" +
            """|navigationBarsPadding|displayCutoutPadding|imePadding|windowInsetsPadding)\s*\(""",
    )

    @Test
    fun `no screen outside the theme package consumes a window inset`() {
        val root = File(
            System.getProperty("helm.android.src.dir")
                ?: error("helm.android.src.dir is not set; see app/build.gradle.kts"),
        )
        assertTrue("source root not found: $root", root.isDirectory)

        val offenders = root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filterNot {
                it.toRelativeString(root).replace('\\', '/')
                    .startsWith("com/potatomotato/helm/ui/theme/")
            }
            .flatMap { file ->
                file.readLines().withIndex()
                    .filter { (_, line) -> insetModifier.containsMatchIn(line) }
                    .map { (index, line) -> "${file.toRelativeString(root)}:${index + 1}  ${line.trim()}" }
            }
            .toList()

        assertTrue(
            "Window insets are consumed once, by HelmTheme. Remove these:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }

    /**
     * The other half: the rule above is only safe because the root actually
     * does the job. Without this, deleting the padding from HelmTheme would
     * make the suite greener and the app broken.
     */
    @Test
    fun `HelmTheme consumes the safe drawing insets for the whole app`() {
        val root = File(System.getProperty("helm.android.src.dir")!!)
        val theme = File(root, "com/potatomotato/helm/ui/theme/Theme.kt")
        assertTrue("Theme.kt not found at $theme", theme.isFile)

        assertTrue(
            "HelmTheme must consume the safe-drawing insets — it is the only " +
                "place in the app permitted to, so if it stops, nothing does.",
            theme.readText().contains("safeDrawingPadding()"),
        )
    }
}
