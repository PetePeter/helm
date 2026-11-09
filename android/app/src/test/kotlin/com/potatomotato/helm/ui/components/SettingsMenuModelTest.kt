package com.potatomotato.helm.ui.components

import com.potatomotato.helm.data.WirelessAdbState
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
            wirelessAdb = WirelessAdbState(supported = true, enabled = true, localIp = "192.0.2.7"),
        ).rows

        assertEquals(
            listOf(
                SettingsMenuAction.Notifications,
                SettingsMenuAction.WirelessAdb,
                SettingsMenuAction.ExportLog,
                SettingsMenuAction.Desktops,
            ),
            rows.map { it.action },
        )
        assertEquals(false, rows[0].switchChecked)
        assertEquals(true, rows[1].switchChecked)
        assertEquals("192.0.2.7", rows[1].supportingText)
    }

    @Test
    fun `Wireless ADB is omitted when unsupported`() {
        val rows = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = false, enabled = false, localIp = null),
        ).rows

        assertEquals(
            listOf(SettingsMenuAction.Notifications, SettingsMenuAction.ExportLog, SettingsMenuAction.Desktops),
            rows.map { it.action },
        )
    }

    @Test
    fun `the IP subtitle appears only when Wireless ADB is on and an IP is available`() {
        val disabled = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = true, enabled = false, localIp = "192.0.2.7"),
        ).rows[1]
        val enabledWithoutIp = model(
            notificationsEnabled = true,
            wirelessAdb = WirelessAdbState(supported = true, enabled = true, localIp = null),
        ).rows[1]

        assertNull(disabled.supportingText)
        assertNull(enabledWithoutIp.supportingText)
    }

    private fun model(
        notificationsEnabled: Boolean,
        wirelessAdb: WirelessAdbState = WirelessAdbState(supported = true, enabled = false, localIp = null),
    ) = settingsMenuModel(notificationsEnabled, wirelessAdb)
}