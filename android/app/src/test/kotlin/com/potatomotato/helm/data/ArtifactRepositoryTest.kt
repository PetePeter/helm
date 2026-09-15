package com.potatomotato.helm.data

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository behind the artifacts list and detail screens.
 *
 * The shapes asserted here are the desktop's session-addressed tool results,
 * delivered raw over the phone's `dispatchForPeer` path: `session_artifact_list`
 * answers a JSON ARRAY of `{id, title, kind, versionCount, createdAt, updatedAt,
 * attachments}` — the attachment metadata is ADDITIVE, so an answer without it
 * is as valid as one with it — `session_artifact_get` answers a JSON OBJECT with
 * the same metadata plus ONE version's `requestedVersionContent` — never the
 * whole versions array — and `session_artifact_download` answers the file
 * envelope `{filename, mimeType, base64, version, size}`, which for an
 * ATTACHMENT is the same keys without `version`.
 *
 * The caches are asserted by their one rule: a cache entry leaves only when a
 * fresh parsed answer for its session OMITS it. Nothing else evicts — not a
 * failure, not an undecodable answer, not another session's traffic.
 */
class ArtifactRepositoryTest {

    private val repo = ArtifactRepository()

    @Test
    fun `a session_artifact_list result parses into rows`() {
        val ok = repo.listArrived("s1", listArray())

        assertTrue(ok)
        val artifacts = (repo.list.value as ArtifactList.Ready).artifacts
        assertEquals(listOf("a1", "a2"), artifacts.map { it.id })
        assertEquals("Perf report", artifacts.first().title)
        assertEquals(2, artifacts.first().versionCount)
    }

    @Test
    fun `the list answer carries each artifact's attachment metadata`() {
        repo.listArrived("s1", listArray())

        val artifacts = (repo.list.value as ArtifactList.Ready).artifacts
        assertEquals(
            listOf(
                HelmArtifactAttachment("att1", "chart.png", "image/png", 2048L, 300L),
                HelmArtifactAttachment("att2", "data.bin", null, 10L, 301L),
            ),
            artifacts.first { it.id == "a1" }.attachments,
        )
        // No attachments field at all is simply no attachments — never an error.
        assertEquals(emptyList<HelmArtifactAttachment>(), artifacts.first { it.id == "a2" }.attachments)
    }

    @Test
    fun `one malformed attachment entry is dropped, not the artifact carrying it`() {
        val body = parse(
            """[{"id":"a1","title":"X","attachments":[{"filename":"no id"},{"id":"att9","filename":"ok.txt"}]}]""",
        )

        repo.listArrived("s1", body)

        val attachments = (repo.list.value as ArtifactList.Ready).artifacts.single().attachments
        assertEquals(listOf("att9"), attachments.map { it.id })
    }

    @Test
    fun `a row without an id is dropped, not invented`() {
        repo.listArrived("s1", parse("""[{"id":"a1","title":"Report"},{"title":"no id"}]"""))

        assertEquals(listOf("a1"), (repo.list.value as ArtifactList.Ready).artifacts.map { it.id })
    }

    @Test
    fun `a kind this build has never met is carried, not refused`() {
        repo.listArrived("s1", parse("""[{"id":"a1","title":"X","kind":"mermaid","versionCount":1}]"""))

        assertEquals("mermaid", (repo.list.value as ArtifactList.Ready).artifacts.single().kind)
    }

    @Test
    fun `a list answer that is not an array leaves the previous list standing`() {
        repo.listArrived("s1", listArray())

        assertFalse(repo.listArrived("s1", parse("""{"items":[]}""")))
        // The previous, readable list still stands.
        assertEquals(
            listOf("a1", "a2"),
            (repo.list.value as ArtifactList.Ready).artifacts.map { it.id },
        )
    }

    @Test
    fun `a fresh ask replaces any failure and names the session it is for`() {
        repo.listFailed("s1", "Helm did not answer")
        repo.listRequested("s2")

        val loading = repo.list.value as ArtifactList.Loading
        assertEquals("s2", loading.sessionId)
    }

    @Test
    fun `a failure is state the screen can read`() {
        repo.listRequested("s1")
        repo.listFailed("s1", "Tool not permitted")

        val failed = repo.list.value as ArtifactList.Failed
        assertEquals("Tool not permitted", failed.message)
    }

    @Test
    fun `an answer for another session never lands as this session's list`() {
        repo.listRequested("s2")

        repo.listArrived("s1", listArray())

        // The user opened s2's artifacts; a late answer for s1 must not be shown
        // under s2's name. It is dropped, and the screen keeps waiting for s2.
        assertTrue(repo.list.value is ArtifactList.Loading)
    }

    // ------------------------------------------------------------------ caches

    @Test
    fun `a first visit waits, a re-visit shows the cached rows while they refresh`() {
        repo.listRequested("s1")
        assertTrue(repo.list.value is ArtifactList.Loading)

        repo.listArrived("s1", listArray())
        repo.listRequested("s1")

        val refreshing = repo.list.value as ArtifactList.Refreshing
        assertEquals("s1", refreshing.sessionId)
        assertEquals(listOf("a1", "a2"), refreshing.cached.map { it.id })
    }

    @Test
    fun `a failed refresh never evicts the cache`() {
        repo.listArrived("s1", listArray())
        repo.listFailed("s1", "The link dropped")

        repo.listRequested("s1")

        // A failed ask is no evidence an artifact left; the rows stay askable.
        assertEquals(listOf("a1", "a2"), (repo.list.value as ArtifactList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `an artifact the fresh answer omits is purged from the cache`() {
        repo.listArrived("s1", listArray())

        // a2 is gone on the desktop; the fresh answer names only a1.
        repo.listArrived("s1", parse("""[{"id":"a1","title":"Perf report"}]"""))
        repo.listRequested("s1")

        assertEquals(listOf("a1"), (repo.list.value as ArtifactList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `another session's list never purges this session's cache`() {
        repo.listArrived("s1", listArray())

        repo.listArrived("s2", parse("""[]"""))

        repo.listRequested("s1")
        assertEquals(listOf("a1", "a2"), (repo.list.value as ArtifactList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a re-read of an already-read body shows the cache while it refreshes`() {
        repo.readArrived("s1", "a1", null, parse(readJson()))

        repo.readRequested("s1", "a1", null)

        val refreshing = repo.read.value as ArtifactRead.Refreshing
        assertEquals("# Report\n\nBody.", refreshing.cached.content)
        // The ASK, not the answer, names the version — the latest is asked as
        // null and must still be findable as null.
        assertNull(refreshing.version)
    }

    @Test
    fun `a different version or session is a different cache slot`() {
        repo.readArrived("s1", "a1", null, parse(readJson()))

        repo.readRequested("s1", "a1", 2)
        assertTrue(repo.read.value is ArtifactRead.Loading)

        repo.readRequested("s2", "a1", null)
        assertTrue(repo.read.value is ArtifactRead.Loading)
    }

    @Test
    fun `a read whose artifact the fresh list omits is purged from the cache`() {
        repo.readArrived("s1", "a1", null, parse(readJson()))

        // The desktop deleted a2 — and a1 too, in this answer.
        repo.listArrived("s1", parse("""[{"id":"a2","title":"Landing page"}]"""))

        repo.readRequested("s1", "a1", null)
        assertTrue(repo.read.value is ArtifactRead.Loading)
    }

    @Test
    fun `a read whose artifact is still listed survives every other session's purge`() {
        repo.readArrived("s1", "a1", null, parse(readJson()))

        // s2's list omits everything; s1's cached read is not s2's to purge.
        repo.listArrived("s2", parse("""[]"""))
        // And a failed s1 refresh is no evidence either.
        repo.listFailed("s1", "Tool not permitted")

        repo.readRequested("s1", "a1", null)
        assertTrue(repo.read.value is ArtifactRead.Refreshing)
    }

    @Test
    fun `a late read for another artifact never lands on this one`() {
        repo.readRequested("s2", "a2", null)

        repo.readArrived("s1", "a1", null, parse(readJson()))

        assertEquals("a2", (repo.read.value as ArtifactRead.Loading).artifactId)
    }

    @Test
    fun `a late version answer cannot overwrite the version now being read`() {
        repo.readRequested("s1", "a1", version = 3)

        repo.readArrived("s1", "a1", version = 2, result = parse(readJson()))

        // The user moved on to v3; the v2 body arriving late is stale.
        assertEquals(3, (repo.read.value as ArtifactRead.Loading).version)
    }

    @Test
    fun `a late version answer cannot overwrite a refreshing read either`() {
        repo.readArrived("s1", "a1", null, parse(readJson()))
        repo.readRequested("s1", "a1", null)

        repo.readArrived("s2", "a1", 2, parse(readJson()))

        assertTrue(repo.read.value is ArtifactRead.Refreshing)
    }

    @Test
    fun `a read lands as metadata plus the one body that was asked for`() {
        val ok = repo.readArrived("s1", "a1", null, parse(readJson()))

        assertTrue(ok)
        val done = repo.read.value as ArtifactRead.Done
        assertEquals("a1", done.read.artifact.id)
        assertEquals("Perf report", done.read.artifact.title)
        assertEquals(3, done.read.artifact.versionCount)
        assertEquals(2, done.read.requestedVersion)
        assertEquals("# Report\n\nBody.", done.read.content)
    }

    @Test
    fun `an empty version body is a valid read`() {
        val body = parse("""{"id":"a1","title":"T","requestedVersion":1,"requestedVersionContent":""}""")
        assertTrue(repo.readArrived("s1", "a1", null, body))
        assertEquals("", (repo.read.value as ArtifactRead.Done).read.content)
    }

    @Test
    fun `a read without a body is undecodable, not an empty screen`() {
        repo.readRequested("s1", "a1", null)

        assertFalse(repo.readArrived("s1", "a1", null, parse("""{"id":"a1","title":"T"}""")))
        assertTrue(repo.read.value is ArtifactRead.Loading)
    }

    @Test
    fun `a read failure is state the screen can read`() {
        repo.readRequested("s1", "a1", null)
        repo.readFailed("a1", "Artifact a1 has no version 9")

        assertEquals("Artifact a1 has no version 9", (repo.read.value as ArtifactRead.Failed).message)
    }

    // ------------------------------------------------------------------ save

    @Test
    fun `a download answer decodes into the file it names`() {
        repo.downloadRequested("a1")
        val ok = repo.downloadArrived("a1", parse(downloadJson()))

        assertTrue(ok)
        val ready = repo.save.value as ArtifactSave.Ready
        assertEquals("Perf-report.md", ready.file.filename)
        assertEquals("text/markdown", ready.file.mimeType)
        assertEquals(2, ready.file.version)
        assertEquals("a1", ready.file.artifactId)
        assertEquals("hello", String(ready.file.bytes, Charsets.UTF_8))
    }

    @Test
    fun `an attachment's file envelope answers without a version and still lands`() {
        repo.downloadRequested("a1")

        // The attachment shape: the same keys MINUS version — the desktop's
        // answer for a binary file stored beside the artifact.
        val ok = repo.downloadArrived(
            "a1",
            parse("""{"filename":"chart.png","mimeType":"image/png","base64":"aGVsbG8=","size":5}"""),
        )

        assertTrue(ok)
        val ready = repo.save.value as ArtifactSave.Ready
        assertEquals("chart.png", ready.file.filename)
        assertEquals("image/png", ready.file.mimeType)
        assertEquals("hello", String(ready.file.bytes, Charsets.UTF_8))
    }

    @Test
    fun `an answer with no base64 body is undecodable, not an empty file`() {
        repo.downloadRequested("a1")

        assertFalse(repo.downloadArrived("a1", parse("""{"filename":"x.md","mimeType":"text/plain"}""")))
        // Still the ask that is waiting — the file simply has not arrived.
        assertTrue(repo.save.value is ArtifactSave.Downloading)
    }

    @Test
    fun `a base64 body that is not base64 is a failure, not a corrupt file`() {
        repo.downloadRequested("a1")

        assertFalse(
            repo.downloadArrived(
                "a1",
                parse("""{"filename":"x.md","mimeType":"text/plain","base64":"!!not base64!!"}"""),
            ),
        )
        assertTrue(repo.save.value is ArtifactSave.Downloading)
    }

    @Test
    fun `a late file for another artifact never lands as this one's`() {
        repo.downloadRequested("a2")

        repo.downloadArrived("a1", parse(downloadJson()))

        assertEquals("a2", (repo.save.value as ArtifactSave.Downloading).artifactId)
    }

    @Test
    fun `the file landing on disk is what completes the save`() {
        repo.downloadRequested("a1")
        repo.downloadArrived("a1", parse(downloadJson()))

        repo.saveLanded("a1", "Downloads/Perf-report.md")

        val saved = repo.save.value as ArtifactSave.Saved
        assertEquals("Downloads/Perf-report.md", saved.path)
    }

    @Test
    fun `a save the device refuses is a failure the row can read`() {
        repo.saveLanded("a1", "Downloads/Perf-report.md")

        repo.saveFailed("a1", "No space left on the phone")

        assertEquals("No space left on the phone", (repo.save.value as ArtifactSave.Failed).message)
    }

    @Test
    fun `a fresh ask replaces a finished save`() {
        repo.downloadRequested("a1")
        repo.downloadArrived("a1", parse(downloadJson()))
        repo.saveLanded("a1", "Downloads/Perf-report.md")

        repo.downloadRequested("a1")

        assertTrue(repo.save.value is ArtifactSave.Downloading)
    }

    @Test
    fun `a download failure is state the row can read`() {
        repo.downloadRequested("a1")

        repo.downloadFailed("a1", "The link dropped before Helm answered")

        assertEquals(
            "The link dropped before Helm answered",
            (repo.save.value as ArtifactSave.Failed).message,
        )
    }

    /** The wire's answer as the envelope delivers it: PARSED, not text. */
    private fun parse(json: String): Any = org.json.JSONTokener(json).nextValue()

    private fun listArray(): JSONArray = JSONArray().apply {
        put(
            org.json.JSONObject(
                """{"id":"a1","title":"Perf report","kind":"markdown","versionCount":2,"createdAt":100,"updatedAt":200,""" +
                    """"attachments":[{"id":"att1","filename":"chart.png","contentType":"image/png","sizeBytes":2048,"createdAt":300},""" +
                    """{"id":"att2","filename":"data.bin","sizeBytes":10,"createdAt":301}]}""",
            ),
        )
        put(org.json.JSONObject("""{"id":"a2","title":"Landing page","kind":"html","versionCount":1,"createdAt":100,"updatedAt":150}"""))
    }

    private fun readJson(): String =
        """{"id":"a1","title":"Perf report","kind":"markdown","versionCount":3,"createdAt":100,"updatedAt":200,""" +
            // In a RAW string "\n" is literally backslash-n — which IS the JSON
            // escape — so the parsed content has real newlines, which is what the
            // Done assertion compares against.
            """"requestedVersion":2,"requestedVersionContent":"# Report\n\nBody."}"""

    /** `hello` in base64, the way the desktop's download envelope carries it. */
    private fun downloadJson(): String =
        """{"filename":"Perf-report.md","mimeType":"text/markdown","base64":"aGVsbG8=","version":2,"size":5}"""
}
