package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository behind the context browser.
 *
 * `project_list` answers a JSON ARRAY of `{id, name, canonicalPath, directories,
 * rootKind}` — only the three fields the phone shows are kept — and `context_list`
 * / `context_get` answer context nodes with their full `content`, a free-text
 * `type`, a `readonly`/`writable` permission and a nullable canvas position.
 *
 * READ-ONLY by design in this phase: there is no write method to assert, and the
 * permission field is carried so a later phase can refuse one honestly.
 */
class ContextRepositoryTest {

    private val repo = ContextRepository()

    @Test
    fun `a first ask waits and the project answer lands as rows`() {
        repo.projectsRequested()
        assertEquals(ProjectList.Loading, repo.projects.value)

        assertTrue(
            repo.projectsArrived(
                parse(
                    """[{"id":"proj1","name":"Helm","canonicalPath":"x:\\coding\\gamepad-cli-hub","directories":[]},""" +
                        """{"id":"proj2","name":"Charger","canonicalPath":"/c"}]""",
                ),
            ),
        )

        // Rows come back A-Z by name, whatever order the desktop answered in.
        assertEquals(
            listOf(
                HelmProject("proj2", "Charger", "/c"),
                HelmProject("proj1", "Helm", "x:\\coding\\gamepad-cli-hub"),
            ),
            (repo.projects.value as ProjectList.Ready).projects,
        )
    }

    @Test
    fun `projects arrive sorted by name, case-insensitive`() {
        // The desktop answers in creation order; the picker reads A-Z.
        assertTrue(
            repo.projectsArrived(
                parse(
                    """[{"id":"p3","name":"zed","canonicalPath":"/z"},""" +
                        """{"id":"p1","name":"Alpha","canonicalPath":"/a"},""" +
                        """{"id":"p2","name":"beta","canonicalPath":"/b"}]""",
                ),
            ),
        )

        assertEquals(
            listOf("p1", "p2", "p3"),
            (repo.projects.value as ProjectList.Ready).projects.map { it.id },
        )
    }

    @Test
    fun `a re-visit shows the cached projects and a failure never evicts them`() {
        repo.projectsArrived(parse("""[{"id":"proj1","name":"Helm","canonicalPath":"/h"}]"""))

        repo.projectsFailed("Tool not permitted")
        assertEquals("Tool not permitted", (repo.projects.value as ProjectList.Failed).message)

        repo.projectsRequested()
        assertEquals(listOf("proj1"), (repo.projects.value as ProjectList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a project answer that is not an array leaves the previous rows standing`() {
        repo.projectsArrived(parse("""[{"id":"proj1","name":"Helm","canonicalPath":"/h"}]"""))

        assertFalse(repo.projectsArrived(parse("""{"items":[]}""")))

        assertEquals(listOf("proj1"), (repo.projects.value as ProjectList.Ready).projects.map { it.id })
    }

    // --------------------------------------------------------------- node lists

    @Test
    fun `a context list lands with each node's body and permission`() {
        repo.listRequested("proj1")

        assertTrue(repo.listArrived("proj1", parse(listJson())))

        val ready = repo.list.value as ContextList.Ready
        assertEquals(listOf("c1", "c2"), ready.contexts.map { it.id })
        val first = ready.contexts.first()
        assertEquals("Testing notes", first.title)
        assertEquals("Testing", first.type)
        assertEquals(ContextPermission.Writable, first.permission)
        assertEquals("Run the suite first.", first.content)
        assertEquals(12.5, first.x!!, 0.0)
        assertEquals(-4.0, first.y!!, 0.0)
    }

    @Test
    fun `a node never dragged has no invented position`() {
        repo.listArrived("proj1", parse("""[{"id":"c1","projectId":"proj1","title":"T","x":null}]"""))

        val node = (repo.list.value as ContextList.Ready).contexts.single()
        // JSON null and an absent key are both "never positioned"; an origin of
        // (0,0) would be a placement the desktop never made.
        assertNull(node.x)
        assertNull(node.y)
    }

    @Test
    fun `an unrecognised permission reads as readonly, the safe side`() {
        repo.listArrived("proj1", parse("""[{"id":"c1","projectId":"proj1","title":"T","permission":"append"}]"""))

        assertEquals(
            ContextPermission.Readonly,
            (repo.list.value as ContextList.Ready).contexts.single().permission,
        )
    }

    @Test
    fun `an answer for a superseded project is dropped, not applied`() {
        repo.listRequested("proj2")

        repo.listArrived("proj1", parse(listJson()))

        assertEquals(ContextList.Loading("proj2"), repo.list.value)
    }

    @Test
    fun `two projects are cached independently`() {
        repo.listArrived("proj1", parse(listJson()))
        repo.listRequested("proj2")
        repo.listArrived("proj2", parse("""[{"id":"c9","projectId":"proj2","title":"Other"}]"""))

        assertEquals(listOf("c1", "c2"), repo.cachedContexts("proj1").map { it.id })
        assertEquals(listOf("c9"), repo.cachedContexts("proj2").map { it.id })

        repo.listRequested("proj1")
        assertEquals(listOf("c1", "c2"), (repo.list.value as ContextList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a failed list is state the screen can read and never evicts the cache`() {
        repo.listArrived("proj1", parse(listJson()))

        repo.listFailed("proj1", "The link dropped")
        assertEquals("The link dropped", (repo.list.value as ContextList.Failed).message)

        repo.listRequested("proj1")
        assertEquals(listOf("c1", "c2"), (repo.list.value as ContextList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a list answer that is not an array leaves the previous nodes standing`() {
        repo.listArrived("proj1", parse(listJson()))

        assertFalse(repo.listArrived("proj1", parse("""{"items":[]}""")))

        assertEquals(listOf("c1", "c2"), (repo.list.value as ContextList.Ready).contexts.map { it.id })
    }

    @Test
    fun `a node the fresh answer omits leaves the detail cache`() {
        repo.detailArrived("c1", parse("""{"id":"c1","projectId":"proj1","title":"T","content":"body"}"""))

        repo.listArrived("proj1", parse("""[{"id":"c2","projectId":"proj1","title":"Other"}]"""))

        repo.detailRequested("c1")
        assertEquals(ContextDetail.Loading("c1"), repo.detail.value)
    }

    // ------------------------------------------------------------------- detail

    @Test
    fun `a context_get answer lands as the node it named`() {
        repo.detailRequested("c1")

        assertTrue(
            repo.detailArrived(
                "c1",
                parse(
                    """{"id":"c1","projectId":"proj1","title":"Testing notes","type":"Testing",""" +
                        """"permission":"readonly","content":"Run the suite first.","x":1,"y":2,""" +
                        """"createdAt":10,"updatedAt":20}""",
                ),
            ),
        )

        val node = (repo.detail.value as ContextDetail.Ready).context
        assertEquals("Run the suite first.", node.content)
        assertEquals(ContextPermission.Readonly, node.permission)
        assertEquals(20L, node.updatedAtEpochMs)
    }

    @Test
    fun `a re-read of a node already read shows the cache while it refreshes`() {
        repo.detailArrived("c1", parse("""{"id":"c1","projectId":"proj1","title":"T","content":"body"}"""))

        repo.detailRequested("c1")

        assertEquals("body", (repo.detail.value as ContextDetail.Refreshing).cached.content)
    }

    @Test
    fun `a late answer for another node never lands on this one`() {
        repo.detailRequested("c2")

        repo.detailArrived("c1", parse("""{"id":"c1","projectId":"proj1","title":"T"}"""))

        assertEquals(ContextDetail.Loading("c2"), repo.detail.value)
    }

    @Test
    fun `a context_get answer that is not a node says so instead of loading forever`() {
        repo.detailRequested("c1")

        assertFalse(repo.detailArrived("c1", parse("""{"items":[]}""")))
        assertEquals(ContextDetail.Loading("c1"), repo.detail.value)

        repo.detailFailed("c1", "Context not found: c1")
        assertEquals("Context not found: c1", (repo.detail.value as ContextDetail.Failed).message)
    }

    /**
     * REGRESSION — see [PlanRepositoryTest]. The guard read the ask off the
     * current state, and a settled Ready carries none, so the superseded
     * project's late answer was applied and wedged the live surface.
     */
    @Test
    fun `a node answer for a superseded project never lands after the newer one settled`() {
        repo.listRequested("projA")
        repo.listRequested("projB")

        repo.listArrived("projB", parse("""[{"id":"cb","projectId":"projB","title":"B note"}]"""))
        repo.listArrived("projA", parse("""[{"id":"ca","projectId":"projA","title":"A note"}]"""))

        val ready = repo.list.value as ContextList.Ready
        assertEquals("projB", ready.projectId)
        assertEquals(listOf("cb"), ready.contexts.map { it.id })
    }

    @Test
    fun `a node detail for a superseded node never lands after the newer one settled`() {
        repo.detailRequested("c1")
        repo.detailRequested("c2")

        repo.detailArrived("c2", parse("""{"id":"c2","projectId":"proj1","title":"Second"}"""))
        repo.detailArrived("c1", parse("""{"id":"c1","projectId":"proj1","title":"First"}"""))

        assertEquals("c2", (repo.detail.value as ContextDetail.Ready).context.id)
    }

    /** The wire's answer as the envelope delivers it: PARSED, not text. */
    private fun parse(json: String): Any = org.json.JSONTokener(json).nextValue()

    private fun listJson(): String =
        """[{"id":"c1","projectId":"proj1","title":"Testing notes","type":"Testing","permission":"writable",""" +
            """"content":"Run the suite first.","x":12.5,"y":-4,"createdAt":10,"updatedAt":20},""" +
            """{"id":"c2","projectId":"proj1","title":"Coding notes","type":"Coding","permission":"readonly",""" +
            """"content":"","x":null,"y":null,"createdAt":11,"updatedAt":21}]"""
}
