package com.potatomotato.helm.data

import com.potatomotato.helm.loadFixture
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Artifacts strip's filter and sort, run against the SAME vectors the
 * desktop's `listArtifacts` is tested with (tests/fixtures/artifact-list-vectors.json),
 * so a chip means the same thing on every surface.
 */
class ArtifactListRulesTest {

    private val vectors = loadFixture("artifact-list-vectors.json")

    private val artifacts: List<HelmArtifact> = vectors.getJSONArray("artifacts").let { rows ->
        (0 until rows.length()).map { i ->
            val r = rows.getJSONObject(i)
            HelmArtifact(
                id = r.getString("id"),
                title = r.getString("title"),
                kind = r.getString("kind"),
                versionCount = 1,
                createdAtEpochMs = r.getLong("createdAt"),
                updatedAtEpochMs = r.getLong("updatedAt"),
                intent = ArtifactIntent.fromWire(r.getString("intent")),
                label = r.getString("label"),
            )
        }
    }

    @Test
    fun `every shared vector case filters and sorts like the desktop`() {
        val cases = vectors.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val prefs = ArtifactListPrefs.fromJson(c.getJSONObject("prefs"))
            val expected = c.getJSONArray("expected").let { e -> (0 until e.length()).map { e.getString(it) } }
            assertEquals(c.getString("name"), expected, ArtifactListRules.list(artifacts, prefs).map { it.id })
        }
    }

    @Test
    fun `prefs survive a save and load round trip`() {
        val prefs = ArtifactListPrefs.Default
            .withKind("IMG", TriState.Yes)
            .withIntent("manifesto", TriState.No)
            .copy(sort = ArtifactSort.AZ)

        assertEquals(prefs, ArtifactListPrefs.fromStored(prefs.toStored()))
    }

    @Test
    fun `unreadable stored prefs are the defaults`() {
        assertEquals(ArtifactListPrefs.Default, ArtifactListPrefs.fromStored(null))
        assertEquals(ArtifactListPrefs.Default, ArtifactListPrefs.fromStored("not json"))
        assertEquals(ArtifactListPrefs.Default, ArtifactListPrefs.fromJson(JSONObject("""{"sort":7}""")))
    }

    @Test
    fun `a chip cycles either, yes, no, either`() {
        assertEquals(listOf(TriState.Yes, TriState.No, TriState.Either), generateSequence(TriState.Either.next()) { it.next() }.take(3).toList())
    }
}
