package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * The Artifacts strip's filter + sort — the phone half of the desktop's
 * renderer/artifacts/artifact-list.ts. Both are pinned to the shared
 * tests/fixtures/artifact-list-vectors.json so a chip means the same thing
 * everywhere. Prefs are per device (a UI choice, not shared state).
 */
enum class TriState(val wire: String) {
    Either("either"), Yes("yes"), No("no");

    /** Tap order on a chip: either → yes → no → either. */
    fun next(): TriState = when (this) { Either -> Yes; Yes -> No; No -> Either }

    companion object {
        fun fromWire(value: Any?): TriState = entries.firstOrNull { it.wire == value } ?: Either
    }
}

enum class ArtifactSort(val wire: String) {
    Created("created"), Updated("updated"), AZ("az");

    companion object {
        fun fromWire(value: Any?): ArtifactSort = entries.firstOrNull { it.wire == value } ?: Updated
    }
}

/** The desktop strip's kind labels; the wire's `label`, else derived from `kind`. */
val ARTIFACT_KIND_LABELS = listOf("MD", "HTML", "IMG", "BIN", "COMPACT")
val ARTIFACT_INTENT_KEYS = ArtifactIntent.entries.map { it.wireValue }

fun artifactLabel(wireLabel: Any?, kind: String): String = when {
    wireLabel is String && wireLabel in ARTIFACT_KIND_LABELS -> wireLabel
    kind == "compact" -> "COMPACT"
    kind == "html" -> "HTML"
    else -> "MD"
}

data class ArtifactListPrefs(
    val kinds: Map<String, TriState>,
    val intents: Map<String, TriState>,
    val sort: ArtifactSort,
) {
    fun withKind(key: String, state: TriState) = copy(kinds = kinds + (key to state))
    fun withIntent(key: String, state: TriState) = copy(intents = intents + (key to state))

    fun toStored(): String = JSONObject()
        .put("kinds", JSONObject(kinds.mapValues { it.value.wire }))
        .put("intents", JSONObject(intents.mapValues { it.value.wire }))
        .put("sort", sort.wire)
        .toString()

    companion object {
        val Default = ArtifactListPrefs(
            kinds = ARTIFACT_KIND_LABELS.associateWith { TriState.Either },
            intents = ARTIFACT_INTENT_KEYS.associateWith { TriState.Either },
            sort = ArtifactSort.Updated,
        )

        /** Same normalisation as the desktop: unknown keys dropped, bad values → either/updated. */
        fun fromJson(json: JSONObject): ArtifactListPrefs {
            fun group(keys: List<String>, raw: JSONObject?) =
                keys.associateWith { TriState.fromWire(raw?.opt(it)) }
            return ArtifactListPrefs(
                kinds = group(ARTIFACT_KIND_LABELS, json.optJSONObject("kinds")),
                intents = group(ARTIFACT_INTENT_KEYS, json.optJSONObject("intents")),
                sort = ArtifactSort.fromWire(json.opt("sort")),
            )
        }

        fun fromStored(stored: String?): ArtifactListPrefs =
            stored?.let { runCatching { fromJson(JSONObject(it)) }.getOrNull() } ?: Default
    }
}

object ArtifactListRules {
    /** A "no" key is excluded; once any key in the group is "yes", only "yes" keys pass. */
    private fun matches(group: Map<String, TriState>, key: String): Boolean {
        val state = group[key] ?: TriState.Either
        if (state == TriState.No) return false
        return if (group.values.any { it == TriState.Yes }) state == TriState.Yes else true
    }

    private fun comparator(sort: ArtifactSort): Comparator<HelmArtifact> = when (sort) {
        ArtifactSort.Created -> compareByDescending { it.createdAtEpochMs }
        ArtifactSort.Updated -> compareByDescending { it.updatedAtEpochMs }
        ArtifactSort.AZ -> Comparator { a, b -> a.title.compareTo(b.title, ignoreCase = true) }
    }

    fun list(artifacts: List<HelmArtifact>, prefs: ArtifactListPrefs): List<HelmArtifact> =
        artifacts
            .filter { matches(prefs.kinds, it.label) && matches(prefs.intents, it.intent.wireValue) }
            .sortedWith(comparator(prefs.sort))
}

/** Per-device persistence over SharedPreferences, in the clear — a UI choice, not a secret. */
class PrefsArtifactListStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): ArtifactListPrefs = ArtifactListPrefs.fromStored(prefs.getString(KEY, null))

    fun save(value: ArtifactListPrefs) {
        prefs.edit().putString(KEY, value.toStored()).apply()
    }

    private companion object {
        const val PREFS_NAME = "helm_artifact_list"
        const val KEY = "prefs"
    }
}
