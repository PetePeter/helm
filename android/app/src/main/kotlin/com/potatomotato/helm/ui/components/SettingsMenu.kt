package com.potatomotato.helm.ui.components

import android.content.Intent
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.WirelessAdb
import com.potatomotato.helm.data.WirelessAdbState
import com.potatomotato.helm.data.WirelessAdbToggleResult
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.keyboard.keyboardPttEvents
import com.potatomotato.helm.voice.PttKeyBinding
import com.potatomotato.helm.voice.PttKeyBindingStore
import com.potatomotato.helm.voice.sharedPttKeyBindingStore

data class SettingsMenuActions(
    val notificationsEnabled: Boolean,
    val onToggleNotifications: () -> Unit,
    val onExportLogs: () -> Unit,
    val onOpenDesktops: () -> Unit,
)

internal enum class SettingsMenuAction {
    Notifications,
    PttBinding,
    WirelessAdb,
    ExportLog,
    Desktops,
}

internal data class SettingsMenuRow(
    val action: SettingsMenuAction,
    val switchChecked: Boolean? = null,
    val supportingText: String? = null,
    val pttBinding: PttKeyBinding? = null,
)

internal data class SettingsMenuModel(
    val mutedBadgeVisible: Boolean,
    val rows: List<SettingsMenuRow>,
)

/** Keep display state separate from Compose so its policy can be tested on the JVM. */
internal fun settingsMenuModel(
    notificationsEnabled: Boolean,
    wirelessAdb: WirelessAdbState,
    pttBinding: PttKeyBinding = PttKeyBinding.AltSpace,
): SettingsMenuModel {
    val rows = buildList {
        add(SettingsMenuRow(SettingsMenuAction.Notifications, switchChecked = notificationsEnabled))
        add(SettingsMenuRow(SettingsMenuAction.PttBinding, pttBinding = pttBinding))
        if (wirelessAdb.supported) {
            add(
                SettingsMenuRow(
                    action = SettingsMenuAction.WirelessAdb,
                    switchChecked = wirelessAdb.enabled,
                    supportingText = wirelessAdb.localIp.takeIf { wirelessAdb.enabled },
                ),
            )
        }
        add(SettingsMenuRow(SettingsMenuAction.ExportLog))
        add(SettingsMenuRow(SettingsMenuAction.Desktops))
    }
    return SettingsMenuModel(
        mutedBadgeVisible = !notificationsEnabled,
        rows = rows,
    )
}

@Composable
internal fun SettingsMenu(actions: SettingsMenuActions) {
    val context = LocalContext.current
    val wirelessAdb = remember(context) { WirelessAdb(context) }
    val pttBindingStore: PttKeyBindingStore = remember(context) { sharedPttKeyBindingStore(context) }
    var wirelessAdbState by remember { mutableStateOf(wirelessAdb.readState()) }
    var pttBinding by remember { mutableStateOf(pttBindingStore.read()) }
    var choosingPttBinding by remember { mutableStateOf(false) }
    val model = settingsMenuModel(actions.notificationsEnabled, wirelessAdbState, pttBinding)
    val muted = model.mutedBadgeVisible
    val anchorDescription = stringResource(
        if (muted) R.string.settings_menu_description_muted else R.string.settings_menu_description,
    )

    HelmDropdown(
        items = model.rows.map { row ->
            val label = when (row.action) {
                SettingsMenuAction.Notifications -> stringResource(R.string.settings_notifications)
                SettingsMenuAction.PttBinding -> stringResource(R.string.settings_ptt_binding)
                SettingsMenuAction.WirelessAdb -> stringResource(R.string.wireless_adb_label)
                SettingsMenuAction.ExportLog -> stringResource(R.string.logs_export_description)
                SettingsMenuAction.Desktops -> stringResource(R.string.transport_menu_desktops)
            }
            HelmDropdownItem(
                label = label,
                switchChecked = row.switchChecked,
                supportingText = when {
                    row.pttBinding != null -> stringResource(pttBindingLabelRes(row.pttBinding))
                    row.supportingText != null -> stringResource(R.string.wireless_adb_ip, row.supportingText)
                    else -> null
                },
            )
        },
        onSelect = { index ->
            when (model.rows[index].action) {
                SettingsMenuAction.Notifications -> actions.onToggleNotifications()
                SettingsMenuAction.PttBinding -> choosingPttBinding = true
                SettingsMenuAction.WirelessAdb -> when (wirelessAdb.toggle()) {
                    is WirelessAdbToggleResult.Updated -> wirelessAdbState = wirelessAdb.readState()
                    WirelessAdbToggleResult.NeedsDeveloperOptions -> context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
                    )
                    WirelessAdbToggleResult.Unsupported -> wirelessAdbState = wirelessAdb.readState()
                    WirelessAdbToggleResult.Failed -> Toast.makeText(
                        context,
                        R.string.wireless_adb_toggle_failed,
                        Toast.LENGTH_LONG,
                    ).show()
                }
                SettingsMenuAction.ExportLog -> actions.onExportLogs()
                SettingsMenuAction.Desktops -> actions.onOpenDesktops()
            }
        },
    ) { expanded, open ->
        // Re-read after returning from Developer options so the row reflects Android's state.
        val openWithFreshState = {
            wirelessAdbState = wirelessAdb.readState()
            open()
        }
        Box(
            modifier = Modifier
                .size(HelmSize.TouchTarget)
                .clickable(onClick = openWithFreshState)
                .semantics(mergeDescendants = true) { contentDescription = anchorDescription },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.settings_glyph),
                color = if (expanded) HelmColors.Accent else HelmColors.Dim,
                style = MaterialTheme.typography.titleLarge,
            )
            if (muted) {
                Text(
                    text = stringResource(R.string.notifications_glyph_off),
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.align(Alignment.TopEnd),
                )
            }
        }
    }

    if (choosingPttBinding) {
        AlertDialog(
            modifier = Modifier.keyboardPttEvents(pttBindingStore),
            onDismissRequest = { choosingPttBinding = false },
            title = { Text(stringResource(R.string.settings_ptt_binding_title)) },
            text = {
                Column {
                    PttKeyBinding.entries.forEach { choice ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    pttBinding = choice
                                    pttBindingStore.write(choice)
                                    choosingPttBinding = false
                                }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = pttBinding == choice, onClick = null)
                            Text(stringResource(pttBindingLabelRes(choice)))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { choosingPttBinding = false }) {
                    Text(stringResource(R.string.settings_ptt_binding_cancel))
                }
            },
        )
    }
}

private fun pttBindingLabelRes(binding: PttKeyBinding): Int = when (binding) {
    PttKeyBinding.AltSpace -> R.string.settings_ptt_binding_alt_space
    PttKeyBinding.RightControl -> R.string.settings_ptt_binding_right_control
    PttKeyBinding.Backtick -> R.string.settings_ptt_binding_backtick
}
