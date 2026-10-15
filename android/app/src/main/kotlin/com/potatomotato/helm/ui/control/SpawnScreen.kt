package com.potatomotato.helm.ui.control

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.HelmDirectory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.SpawnMachine
import com.potatomotato.helm.ui.plans.PlanSpawn
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
 *
 * With fleet peers online that let the desktop in, a "Runs on" row picks the
 * machine: its CLIs and folders come from that machine and the desktop opens the result
 * as a Remote row (`peer_spawn`). A plan's spawn always runs on this desktop.
 *
 * [plan] turns the same form into a plan's spawner: its directory is shown but
 * not choosable, its name is suggested but editable, and its read prompt rides
 * the spawn. Null is the ordinary New session form, unchanged.
 */
@Composable
fun SpawnScreen(
    directories: List<HelmDirectory>,
    clis: List<HelmCli>,
    directoriesError: String?,
    sessions: List<HelmSession>,
    linkState: LinkState,
    /** A spawn is already crossing the wire; a second cannot be asked for. */
    spawnInFlight: Boolean,
    /** Fleet peers the desktop may spawn on; empty hides the machine row. */
    machines: List<SpawnMachine>,
    /** The machine changed (null = this desktop): load its CLIs and folders. */
    onMachine: (machineId: String?) -> Unit,
    onSpawn: (dirPath: String, cliType: String, name: String, machineId: String?) -> Unit,
    onRetryDirectories: (machineId: String?) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    plan: PlanSpawn? = null,
) {
    var machineId by rememberSaveable { mutableStateOf<String?>(null) }

    // The catalogue when the chosen machine answered it; for this desktop only,
    // the distinct CLIs already running when it did not — those ids are this
    // desktop's and mean nothing on another machine. Labelled as the desktop does.
    val cliChoices = remember(clis, sessions, machineId) {
        if (clis.isNotEmpty() || machineId != null) {
            clis.map { it.cliType to it.name }
        } else {
            sessions.filter { it.cliType.isNotEmpty() }
                .distinctBy { it.cliType }
                .map { it.cliType to it.cliTypeName.ifEmpty { it.cliType } }
        }
    }

    var dirPath by rememberSaveable(plan) { mutableStateOf(plan?.dirPath) }
    var cliType by rememberSaveable { mutableStateOf<String?>(null) }
    var name by rememberSaveable(plan) { mutableStateOf(plan?.name.orEmpty()) }
    var pickerPage by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedProjectKey by rememberSaveable { mutableStateOf<String?>(null) }
    val directoryGroups = remember(directories) { groupSpawnDirectories(directories) }
    val selectedProject = directoryGroups?.firstOrNull { it.key == selectedProjectKey }

    val closePicker = {
        if (pickerPage == "folders" && directoryGroups != null) {
            pickerPage = "projects"
            selectedProjectKey = null
        } else {
            pickerPage = null
            selectedProjectKey = null
        }
    }
    BackHandler(enabled = pickerPage != null) { closePicker() }

    LaunchedEffect(pickerPage, directoryGroups, selectedProjectKey, selectedProject, directories) {
        when {
            pickerPage == "projects" && directoryGroups == null -> {
                pickerPage = null
                selectedProjectKey = null
            }
            pickerPage == "folders" && selectedProject == null -> {
                pickerPage = if (directoryGroups == null) null else "projects"
                selectedProjectKey = null
            }
            pickerPage == "flat" && directories.isEmpty() -> pickerPage = null
        }
    }

    LaunchedEffect(directories, directoriesError, plan, dirPath) {
        if (plan == null && dirPath != null
            && (directoriesError != null || directories.isNotEmpty())
            && directories.none { it.path == dirPath }
        ) {
            dirPath = null
            pickerPage = null
            selectedProjectKey = null
        }
    }

    // Raised on the tap itself (see SpawnTapLatch); released by the spawn's
    // answer plus the minimum hold. A success navigates away first.
    var tappedAt by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(tappedAt, spawnInFlight) {
        val at = tappedAt ?: return@LaunchedEffect
        val wait = SpawnTapLatch.releaseInMs(at, spawnInFlight, SystemClock.uptimeMillis()) ?: return@LaunchedEffect
        delay(wait)
        tappedAt = null
    }

    val appBarTitle = when (pickerPage) {
        "projects" -> stringResource(R.string.spawn_choose_project)
        "folders" -> selectedProject?.title ?: stringResource(R.string.spawn_title)
        "flat" -> stringResource(R.string.spawn_where)
        else -> stringResource(if (plan != null) R.string.spawn_plan_title else R.string.spawn_title)
    }
    val appBarSubtitle = when (pickerPage) {
        "projects" -> stringResource(R.string.spawn_picker_project_subtitle)
        "folders" -> stringResource(R.string.spawn_choose_folder)
        else -> if (plan == null && pickerPage == null) {
            stringResource(R.string.spawn_picker_form_subtitle)
        } else {
            null
        }
    }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = appBarTitle,
            subtitle = appBarSubtitle,
            linkState = linkState,
            onBack = { if (pickerPage != null) closePicker() else onBack() },
        )

        if (pickerPage == null) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(HelmSpacing.Gutter),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
            ) {
                // NAME FIRST. It is the only field that has to be typed, and typing
                // is what the soft keyboard buries: put it at the top and the
                // keyboard covers the selectors below it, which are scrollable,
                // rather than the field itself.
                FieldLabel(stringResource(R.string.spawn_name))
                NameField(name = name, onName = { name = it })

                // Then the machine, ahead of its folders: they are that machine's paths.
                if (plan == null && machines.isNotEmpty()) {
                    FieldLabel(stringResource(R.string.spawn_runs_on))
                    val choose = { id: String? ->
                        if (id != machineId) {
                            machineId = id
                            cliType = null
                            dirPath = null
                            pickerPage = null
                            selectedProjectKey = null
                            onMachine(id)
                        }
                    }
                    Choice(
                        label = stringResource(R.string.spawn_this_desktop),
                        detail = null,
                        selected = machineId == null,
                        onClick = { choose(null) },
                    )
                    for (machine in machines) {
                        Choice(
                            label = "🖥 ${machine.name}",
                            detail = null,
                            selected = machine.id == machineId,
                            onClick = { choose(machine.id) },
                        )
                    }
                }

                // Then the CLI. The short list sits above the project picker.
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
                    // A plan's directory is fixed: shown, selected, and not a choice.
                    // Never swapped for another if the list lacks it — a plan read
                    // from the wrong project is worse than no session.
                    plan != null -> {
                        val locked = directories.firstOrNull { it.path == plan.dirPath }
                        Choice(
                            label = locked?.let(::directoryLabel) ?: plan.dirPath,
                            detail = locked?.path,
                            selected = true,
                            onClick = null,
                        )
                    }
                    // A dead fetch says so, with a way to try again. The waiting
                    // hint is only for a fetch that has not answered yet.
                    directoriesError != null -> {
                        Hint(directoriesError)
                        GhostButton(text = stringResource(R.string.spawn_retry), onClick = { onRetryDirectories(machineId) })
                    }
                    directories.isEmpty() -> Hint(stringResource(R.string.spawn_no_directories))
                    else -> {
                        val selectedDirectory = directories.firstOrNull { it.path == dirPath }
                        Choice(
                            label = selectedDirectory?.let(::directoryLabel) ?: stringResource(R.string.spawn_choose_project),
                            detail = selectedDirectory?.path,
                            selected = selectedDirectory != null,
                            onClick = { pickerPage = if (directoryGroups == null) "flat" else "projects" },
                        )
                    }
                }
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
                val chosenDirAvailable = chosenDir != null &&
                    (plan != null || directories.any { it.path == chosenDir })

                PrimaryButton(
                    text = stringResource(R.string.spawn_start),
                    // Disabled until the two REQUIRED choices are real, and until the
                    // last spawn's answer came back: two taps are two sessions.
                    // The name is optional on the wire: a blank one is omitted and
                    // the desktop names the session after the CLI type.
                    enabled = chosenDirAvailable && chosenCli != null && !spawnInFlight && tappedAt == null,
                    onClick = {
                        if (tappedAt == null) {
                            tappedAt = SystemClock.uptimeMillis()
                            onSpawn(chosenDir.orEmpty(), chosenCli.orEmpty(), chosenName, machineId)
                        }
                    },
                )
                GhostButton(text = stringResource(R.string.spawn_cancel), onClick = onBack)
            }
        } else {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(HelmSpacing.Gutter),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
            ) {
                when (pickerPage) {
                    "projects" -> {
                        PickerStepHeading(
                            step = stringResource(R.string.spawn_picker_project_step),
                            title = stringResource(R.string.spawn_choose_project),
                            hint = stringResource(R.string.spawn_picker_project_hint),
                        )
                        Column(modifier = Modifier.fillMaxWidth()) {
                            PickerDivider()
                            directoryGroups.orEmpty().forEach { group ->
                                val title = if (group.key.isEmpty()) stringResource(R.string.spawn_other) else group.title
                                DirectoryPickerRow(
                                    icon = stringResource(R.string.spawn_picker_project_icon),
                                    title = title,
                                    subtitle = stringResource(R.string.spawn_picker_project_label),
                                    trailing = pluralStringResource(
                                        R.plurals.spawn_folder_count,
                                        group.directories.size,
                                        group.directories.size,
                                    ),
                                    onClick = {
                                        selectedProjectKey = group.key
                                        pickerPage = "folders"
                                    },
                                )
                                PickerDivider()
                            }
                        }
                    }
                    "folders" -> {
                        if (selectedProject != null) {
                            PickerStepHeading(
                                step = stringResource(R.string.spawn_picker_folder_step),
                                title = stringResource(R.string.spawn_choose_folder),
                                hint = selectedProject.title,
                            )
                            Column(modifier = Modifier.fillMaxWidth()) {
                                PickerDivider()
                                for (directory in selectedProject.directories) {
                                    DirectoryPickerRow(
                                        icon = stringResource(R.string.spawn_picker_folder_icon),
                                        title = directory.name,
                                        subtitle = directory.path,
                                        badge = if (directory.isMainFolder()) {
                                            stringResource(R.string.spawn_main_folder)
                                        } else {
                                            null
                                        },
                                        onClick = {
                                            dirPath = directory.path
                                            pickerPage = null
                                            selectedProjectKey = null
                                        },
                                    )
                                    PickerDivider()
                                }
                            }
                        }
                    }
                    "flat" -> directories.forEach { directory ->
                        Choice(
                            label = directoryLabel(directory),
                            detail = directory.path,
                            selected = directory.path == dirPath,
                            onClick = {
                                dirPath = directory.path
                                pickerPage = null
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerStepHeading(step: String, title: String, hint: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = HelmSpacing.Xs),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = step.uppercase(),
            color = HelmColors.Accent,
            style = MaterialTheme.typography.labelSmall.copy(
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
            ),
        )
        Text(
            text = title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(text = hint, color = HelmColors.Dim, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DirectoryPickerRow(
    icon: String,
    title: String,
    subtitle: String,
    trailing: String? = null,
    badge: String? = null,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 66.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 2.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tileShape = RoundedCornerShape(10.dp)
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(tileShape)
                .border(HelmSize.Hairline, HelmColors.Line, tileShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = icon, color = HelmColors.Accent, fontSize = 17.sp)
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs / 2),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                Text(
                    text = title,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (badge != null) PickerBadge(badge)
            }
            Text(
                text = subtitle,
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (trailing != null) {
            Text(text = trailing, color = HelmColors.Dim, style = MaterialTheme.typography.labelSmall)
        }
        Text(
            text = stringResource(R.string.spawn_picker_chevron),
            color = HelmColors.Faint,
            fontSize = 22.sp,
            lineHeight = 22.sp,
        )
    }
}

@Composable
private fun PickerBadge(text: String) {
    val shape = RoundedCornerShape(HelmRadius.Pill)
    Box(
        modifier = Modifier
            .clip(shape)
            .border(HelmSize.Hairline, HelmColors.Accent.copy(alpha = 0.4f), shape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            text = text.uppercase(),
            color = HelmColors.Accent,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.3.sp,
        )
    }
}

@Composable
private fun PickerDivider() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(HelmSize.Hairline)
            .background(HelmColors.Separator),
    )
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
private fun Choice(label: String, detail: String?, selected: Boolean, onClick: (() -> Unit)?) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .border(
                HelmSize.Hairline,
                if (selected) HelmColors.Accent else HelmColors.Line,
                RoundedCornerShape(HelmRadius.Md),
            )
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
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
