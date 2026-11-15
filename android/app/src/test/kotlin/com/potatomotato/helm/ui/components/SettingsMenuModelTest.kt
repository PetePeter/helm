package com.potatomotato.helm.ui.components

import com.potatomotato.helm.data.WirelessAdbState
import com.potatomotato.helm.data.WirelessAdbPortStatus
import com.potatomotato.helm.voice.PttKeyBinding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsMenuModelTest {
    @Test
    fun `the muted badge appears only while notifications are disabled`() {
        assertFalse(model(notificationsEnabled = true).mutedBadgeVisible)
        assertTrue(model(notificationsEnabled = false).mutedBadgeVisible)
    }

    @Test
    fun `supported settings appear in the specified order with their current switch states`() {
        val rows = model(
            notificationsEnabled = false,
            wirelessAdb = WirelessAdbState(
                supported = true,
                enabled = true,
                localIp = "192.0.2.7",
            ),
            wirelessAdbPortStatus = WirelessAdbPortStatus.Resolved(5037),
        ).rows

        assertEquals(
            listOf(
                SettingsMenuAction.Notifications,
                SettingsMenuAction.PttBinding,
                SettingsMenuAction.WirelessAdb,
                SettingsMenuAction.ExportLog,
                SettingsMenuAction.Desktops,
            ),
            rows.map { it.action },
        )
        assertEquals(false, rows[0].switchChecked)
        assertEquals(PttKeyBinding.AltSpace, rows[1].pttBinding)
        assertEquals(true, rows[2].switchChecked)
        assertEquals("192.0.2.7:5037", rows[2].supportingText)
    }

    @Test
    fun `Wireless ADB is omitted when unsupported`() {
        val rows = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = false, enabled = false, localIp = null),
        ).rows

        assertEquals(
            listOf(SettingsMenuAction.Notifications, SettingsMenuAction.PttBinding, SettingsMenuAction.ExportLog, SettingsMenuAction.Desktops),
            rows.map { it.action },
        )
    }

    @Test
    fun `the IP subtitle appears only when Wireless ADB is on and an IP is available`() {
        val disabled = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(
                supported = true,
                enabled = false,
                localIp = "192.0.2.7",
            ),
            wirelessAdbPortStatus = WirelessAdbPortStatus.Resolved(5037),
        ).rows[1]
        val enabledWithoutIp = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = true, enabled = true, localIp = null),
        ).rows[1]

        assertNull(disabled.supportingText)
        assertNull(enabledWithoutIp.supportingText)
    }

    @Test
    fun `loading replaces the previous port while a fresh endpoint is being resolved`() {
        val wirelessAdbState = WirelessAdbState(supported = true, enabled = true, localIp = "192.0.2.7")
        val staleEndpoint = model(
            notificationsEnabled = true,
            wirelessAdb = wirelessAdbState,
            wirelessAdbPortStatus = WirelessAdbPortStatus.Resolved(5037),
        ).rows.first { it.action == SettingsMenuAction.WirelessAdb }
        val loadingEndpoint = model(
            notificationsEnabled = true,
            wirelessAdb = wirelessAdbState,
            wirelessAdbPortStatus = WirelessAdbPortStatus.Loading,
        ).rows.first { it.action == SettingsMenuAction.WirelessAdb }

        assertEquals("192.0.2.7:5037", staleEndpoint.supportingText)
        assertEquals("192.0.2.7:<loading>", loadingEndpoint.supportingText)
    }

    @Test
    fun `the IP remains visible without a port when fresh discovery is unavailable`() {
        val wirelessAdb = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = true, enabled = true, localIp = "192.0.2.7"),
            wirelessAdbPortStatus = WirelessAdbPortStatus.Unavailable,
        ).rows.first { it.action == SettingsMenuAction.WirelessAdb }

        assertEquals("192.0.2.7", wirelessAdb.supportingText)
    }

    @Test
    fun `PTT binding row shows the persisted choice`() {
        val binding = model(notificationsEnabled = true, pttBinding = PttKeyBinding.Backtick)
            .rows.first { it.action == SettingsMenuAction.PttBinding }

        assertEquals(PttKeyBinding.Backtick, binding.pttBinding)
    }

    private fun model(
        notificationsEnabled: Boolean,
        wirelessAdb: WirelessAdbState = WirelessAdbState(supported = true, enabled = false, localIp = null),
        wirelessAdbPortStatus: WirelessAdbPortStatus = WirelessAdbPortStatus.Unavailable,
        pttBinding: PttKeyBinding = PttKeyBinding.AltSpace,
    ) = settingsMenuModel(notificationsEnabled, wirelessAdb, wirelessAdbPortStatus, pttBinding)
}
