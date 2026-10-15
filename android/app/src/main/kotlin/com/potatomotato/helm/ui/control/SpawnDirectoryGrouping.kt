package com.potatomotato.helm.ui.control

import com.potatomotato.helm.data.HelmDirectory

data class SpawnDirectoryGroup(
    val key: String,
    val title: String,
    val directories: List<HelmDirectory>,
)

fun HelmDirectory.isMainFolder(): Boolean =
    isCanonical ?: projectName?.equals(name, ignoreCase = true) ?: false

/** Groups directories by project; null keeps older servers' flat picker intact. */
fun groupSpawnDirectories(directories: List<HelmDirectory>): List<SpawnDirectoryGroup>? {
    if (directories.isEmpty() || directories.none { it.projectId != null || !it.projectName.isNullOrBlank() }) {
        return null
    }

    return directories
        .groupBy { directory ->
            directory.projectId ?: directory.projectName?.takeIf(String::isNotBlank).orEmpty()
        }
        .map { (key, entries) ->
            val title = entries.firstNotNullOfOrNull { it.projectName?.takeIf(String::isNotBlank) }
                ?: entries.firstOrNull { key.isNotEmpty() }?.name
                ?: "Other"
            SpawnDirectoryGroup(
                key = key,
                title = title,
                directories = entries.sortedWith(
                    compareByDescending<HelmDirectory> { it.isMainFolder() }
                        .thenBy { it.name.lowercase() }
                        .thenBy { it.path.lowercase() },
                ),
            )
        }
        .sortedWith(
            compareBy<SpawnDirectoryGroup> { it.key.isEmpty() }
                .thenBy { it.title.lowercase() },
        )
}
