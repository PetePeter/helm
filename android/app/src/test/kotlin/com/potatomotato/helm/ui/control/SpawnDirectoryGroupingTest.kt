package com.potatomotato.helm.ui.control

import com.potatomotato.helm.data.HelmDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SpawnDirectoryGroupingTest {

    @Test
    fun `projects sort by label with canonical folders first and ungrouped folders last`() {
        val groups = groupSpawnDirectories(
            listOf(
                directory("/beta/alt", "docs", "Beta", "beta", false),
                directory("/beta/main", "beta", "Beta", "beta", true),
                directory("/alpha/alt", "examples", "Alpha", "alpha", false),
                directory("/alpha/main", "alpha", "Alpha", "alpha", true),
                directory("/scratch", "scratch"),
            ),
        )

        assertEquals(listOf("alpha", "beta", ""), groups?.map { it.key })
        assertEquals(listOf("alpha", "examples"), groups?.get(0)?.directories?.map { it.name })
        assertEquals(listOf("beta", "docs"), groups?.get(1)?.directories?.map { it.name })
        assertEquals("Other", groups?.last()?.title)
        assertEquals(listOf("scratch"), groups?.last()?.directories?.map { it.name })
    }

    @Test
    fun `older directory responses infer the main folder from the project label`() {
        val groups = groupSpawnDirectories(
            listOf(
                directory("/repo/alternate", "android", "repo"),
                directory("/repo", "repo", "repo"),
            ),
        )

        assertEquals(listOf("repo", "android"), groups?.single()?.directories?.map { it.name })
    }

    @Test
    fun `missing project metadata keeps the caller's flat directory list`() {
        assertNull(
            groupSpawnDirectories(
                listOf(directory("/a", "a"), directory("/b", "b")),
            ),
        )
    }

    private fun directory(
        path: String,
        name: String,
        projectName: String? = null,
        projectId: String? = null,
        isCanonical: Boolean? = null,
    ) = HelmDirectory(path, name, projectName, projectId, isCanonical)
}
