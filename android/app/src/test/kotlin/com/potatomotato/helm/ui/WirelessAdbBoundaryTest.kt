package com.potatomotato.helm.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** W-ADB is a local settings action; remote surfaces must not gain a call path to it. */
class WirelessAdbBoundaryTest {
    @Test
    fun `wire and transport packages do not reference WirelessAdb`() {
        val root = File(
            System.getProperty("helm.android.src.dir")
                ?: error("helm.android.src.dir is not set; see app/build.gradle.kts"),
        )
        assertTrue("source root not found: $root", root.isDirectory)

        val remotePackages = listOf("link", "wire", "ble", "lan")
        val offenders = remotePackages.flatMap { packageName ->
            File(root, "com/potatomotato/helm/$packageName")
                .takeIf { it.isDirectory }
                ?.walkTopDown()
                ?.filter { it.isFile && it.extension == "kt" }
                ?.flatMap { source ->
                    source.readLines().withIndex()
                        .filter { (_, line) -> "WirelessAdb" in line }
                        .map { (index, line) -> "${source.toRelativeString(root)}:${index + 1}: ${line.trim()}" }
                }
                ?.toList()
                .orEmpty()
        }

        assertTrue(
            "WirelessAdb is UI-local and must not be referenced by link/wire/ble/lan:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }
}