package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.HelmDirectory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The spawn form — the sheet's one CREATING action.
 *
 * The mockup draws "Spawn session" greyed and therefore never says what it does.
 * It is a form because `session_create` needs things the sheet does not have:
 * a directory, a CLI type, and (optionally) a name.
 *
 * EVERY FIELD IS FILLED FROM A SURFACE THE PHONE CAN ASK FOR. Directories come
 * from `directory_list`; CLI types come from the `tool_list` catalogue, fetched
 * on entry. When that fetch fails or comes back empty — an older desktop, a
 * refused call — the form falls back to harvesting the distinct CLI types out
 * of the sessions already visible in `session_list`, so it can only offer a
 * KIND of session it can already see running. That fallback is a smaller
 * feature than the catalogue, and an honest one.
 *
 * There is no confirmation. Creating is cheap and reversible; the confirmation
 * budget is spent on closing.
 */
@Composable
fun SpawnScreen(
    directories: List<HelmDirectory>,
    clis: List<HelmCli>,
    directoriesError: String?,
    sessions: List<HelmSession>,
    linkState: LinkState,
    onSpawn: (dirPath: String, cliType: String, name: String) -> Unit,
    onRetryDirectories: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // The catalogue when the desktop answered it; the distinct CLIs already
    // running when it did not. Each row labelled the way the desktop labels it.
    val cliChoices = remember(clis, sessions) {
        if (clis.isNotEmpty()) {
            clis.map { it.cliType to it.name }
        } else {
            sessions.filter { it.cliType.isNotEmpty() }
                .distinctBy { it.cliType }
                .map { it.cliType to it.cliTypeName.ifEmpty { it.cliType } }
        }
    }

    var dirPath by rememberSaveable { mutableStateOf<String?>(null) }
    var cliType by rememberSaveable { mutableStateOf<String?>(null) }
    var name by rememberSaveable { mutableStateOf("") }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = stringResource(R.string.spawn_title),
            linkState = linkState,
            onBack = onBack,
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(HelmSpacing.Gutter),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            // CLI FIRST. What you are launching is the decision you actually
            // make; where it runs is usually already settled. The short list
            // also means the long directory list never buries it off-screen.
            FieldLabel(stringResource(R.string.spawn_which_cli))
            if (cliChoices.isEmpty()) {
                Hint(stringResource(R.string.spawn_no_clis))
            } else {
                for ((type, label) in cliChoices) {
                    Choice(
                        label = label,
                        detail = null,
                        selected = type == cliType,
                        onClick = { cliType = type },
                    )
                }
            }

            FieldLabel(stringResource(R.string.spawn_where))
            when {
                // A dead fetch says so, with a way to try again. The waiting
                // hint is only for a fetch that has not answered yet.
                directoriesError != null -> {
                    Hint(directoriesError)
                    GhostButton(text = stringResource(R.string.spawn_retry), onClick = onRetryDirectories)
                }
                directories.isEmpty() -> Hint(stringResource(R.string.spawn_no_directories))
                else -> {
                    // Row order is the repository's — project label A-Z, path
                    // breaking ties — so the list reads as projects first.
                    for (directory in directories) {
                        Choice(
                            label = directoryLabel(directory),
                            detail = directory.path,
                            selected = directory.path == dirPath,
                            onClick = { dirPath = directory.path },
                        )
                    }
                }
            }

            FieldLabel(stringResource(R.string.spawn_name))
            NameField(name = name, onName = { name = it })
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(HelmColors.Surface)
                .padding(HelmSpacing.Gutter),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            val chosenDir = dirPath
            val chosenCli = cliType
            val chosenName = name.trim()

            PrimaryButton(
                text = stringResource(R.string.spawn_start),
                // Disabled until the two REQUIRED choices are real. The name is
                // optional on the wire: a blank one is omitted and the desktop
                // names the session after the CLI type.
                enabled = chosenDir != null && chosenCli != null,
                onClick = { onSpawn(chosenDir.orEmpty(), chosenCli.orEmpty(), chosenName) },
            )
            GhostButton(text = stringResource(R.string.spawn_cancel), onClick = onBack)
        }
    }
}

/**
 * "Project ▸ folder", or just the folder when there is no project to name.
 *
 * The marker is only drawn when it separates two DIFFERENT things: a project's
 * canonical directory already carries the project's own name, and rendering
 * "Helm ▸ Helm" would be noise pretending to be information.
 */
private fun directoryLabel(directory: HelmDirectory): String {
    val project = directory.projectName
    return if (project.isNullOrEmpty() || project == directory.name) {
        directory.name
    } else {
        "$project ▸ ${directory.name}"
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        color = HelmColors.Dim,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(top = HelmSpacing.Sm),
    )
}

@Composable
private fun Hint(text: String) {
    Text(text = text, color = HelmColors.Faint, style = MaterialTheme.typography.bodySmall)
}

/** One selectable row. Selection is the accent hairline, never a lighter fill. */
@Composable
private fun Choice(label: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .border(
                HelmSize.Hairline,
                if (selected) HelmColors.Accent else HelmColors.Line,
                RoundedCornerShape(HelmRadius.Md),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    ) {
        Text(
            text = label,
            color = if (selected) HelmColors.Txt else HelmColors.Dim,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (detail != null) {
            Text(
                text = detail,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                // The path is the identity, so it is shown; the phone is narrow,
                // so the START is what gets dropped — the tail tells them apart.
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun NameField(name: String, onName: (String) -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Surface2)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    ) {
        BasicTextField(
            value = name,
            onValueChange = onName,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
            cursorBrush = SolidColor(HelmColors.Accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
