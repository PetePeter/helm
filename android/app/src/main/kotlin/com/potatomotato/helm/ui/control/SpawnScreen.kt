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
 * It is a form because `session_create` needs three things the sheet does not
 * have: a directory, a CLI type and a name.
 *
 * EVERY FIELD IS FILLED FROM A SURFACE THE PHONE ALREADY HAS. Directories come
 * from `directory_list`; CLI types are harvested from the sessions already
 * visible in `session_list`, because nothing phone-callable enumerates them. The
 * consequence is deliberate and worth stating: a phone can only spawn a KIND of
 * session it can already see running. That is a smaller feature than the desktop
 * has, and an honest one — the alternative was inventing a tool to populate a
 * picker.
 *
 * There is no confirmation. Creating is cheap and reversible; the confirmation
 * budget is spent on closing.
 */
@Composable
fun SpawnScreen(
    directories: List<HelmDirectory>,
    sessions: List<HelmSession>,
    linkState: LinkState,
    onSpawn: (dirPath: String, cliType: String, name: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Each CLI type once, labelled the way the desktop labels it.
    val clis = remember(sessions) {
        sessions.filter { it.cliType.isNotEmpty() }
            .distinctBy { it.cliType }
            .map { it.cliType to it.cliTypeName.ifEmpty { it.cliType } }
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
            FieldLabel(stringResource(R.string.spawn_where))
            if (directories.isEmpty()) {
                Hint(stringResource(R.string.spawn_no_directories))
            } else {
                for (directory in directories) {
                    Choice(
                        label = directory.name,
                        detail = directory.path,
                        selected = directory.path == dirPath,
                        onClick = { dirPath = directory.path },
                    )
                }
            }

            FieldLabel(stringResource(R.string.spawn_which_cli))
            if (clis.isEmpty()) {
                Hint(stringResource(R.string.spawn_no_clis))
            } else {
                for ((type, label) in clis) {
                    Choice(
                        label = label,
                        detail = null,
                        selected = type == cliType,
                        onClick = { cliType = type },
                    )
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
                // Disabled until all three are real. Helm would refuse an
                // incomplete spawn anyway; being refused for something the screen
                // could see is a worse experience than a button that waits.
                enabled = chosenDir != null && chosenCli != null && chosenName.isNotEmpty(),
                onClick = { onSpawn(chosenDir.orEmpty(), chosenCli.orEmpty(), chosenName) },
            )
            GhostButton(text = stringResource(R.string.spawn_cancel), onClick = onBack)
        }
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
