package com.potatomotato.helm.ui.tablet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LayoutChooserTest {
    @Test fun currentWidthChoosesExpectedShell() {
        assertEquals(TabletLayout.Phone, LayoutChooser.forWidth(599))
        assertEquals(TabletLayout.Collapsed, LayoutChooser.forWidth(600))
        assertEquals(TabletLayout.Collapsed, LayoutChooser.forWidth(839))
        assertEquals(TabletLayout.Expanded, LayoutChooser.forWidth(840))
    }

    @Test fun landscapePreferenceRequiresAnExpandedDeviceDimension() {
        assertFalse(LayoutChooser.shouldPreferLandscape(533, 839))
        assertTrue(LayoutChooser.shouldPreferLandscape(533, 840))
        assertTrue(LayoutChooser.shouldPreferLandscape(900, 600))
    }
}
