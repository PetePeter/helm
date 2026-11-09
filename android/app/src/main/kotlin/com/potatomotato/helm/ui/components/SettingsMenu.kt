package com.potatomotato.helm.ui.components

import android.content.Intent
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import com.potatomotato.helm.R
import com.potatomotato.helm.data.WirelessAdb
import com.potatomotato.helm.data.WirelessAdbState
import com.potatomotato.helm.data.WirelessAdbToggleResult
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize

data class SettingsMenuActions(
    val notificationsEnabled: Boolean,
    val onToggleNotifications: () -> Unit,
    val onExportLogs: () -> Unit,
    val onOpenDesktops: () -> Unit,
)

internal enum class SettingsMenuAction {
    Notifications,
    WirelessAdb,
    ExportLog,
    Desktops,
}

internal data class SettingsMenuRow(
    val action: SettingsMenuAction,
    val switchChecked: Boolean? = null,
    val supportingText: String? = null,
)

internal data class SettingsMenuModel(
    val mutedBadgeVisible: Boolean,
    val rows: List<SettingsMenuRow>,
)

/** Keep display state separate from Compose so its policy can be tested on the JVM. */
internal fun settingsMenuModel(
    notificationsEnabled: Boolean,
    wirelessAdb: WirelessAdbState,
): SettingsMenuModel {
    val rows = buildList {
        add(SettingsMenuRow(SettingsMenuAction.Notifications, switchChecked = notificationsEnabled))
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
    var wirelessAdbState by remember { mutableStateOf(wirelessAdb.readState()) }
    val model = settingsMenuModel(actions.notificationsEnabled, wirelessAdbState)
    val muted = model.mutedBadgeVisible
    val anchorDescription = stringResource(
        if (muted) R.string.settings_menu_description_muted else R.string.settings_menu_description,
    )

    HelmDropdown(
        items = model.rows.map { row ->
            val label = when (row.action) {
                SettingsMenuAction.Notifications -> stringResource(R.string.settings_notifications)
                SettingsMenuAction.WirelessAdb -> stringResource(R.string.wireless_adb_label)
                SettingsMenuAction.ExportLog -> stringResource(R.string.logs_export_description)
                SettingsMenuAction.Desktops -> stringResource(R.string.transport_menu_desktops)
            }
            HelmDropdownItem(
                label = label,
                switchChecked = row.switchChecked,
                supportingText = row.supportingText?.let {
                    stringResource(R.string.wireless_adb_ip, it)
                },
            )
        },
        onSelect = { index ->
            when (model.rows[index].action) {
                SettingsMenuAction.Notifications -> actions.onToggleNotifications()
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
}
