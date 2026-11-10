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

    @Test fun landscapePreferenceRequiresTabletSmallestWidth() {
        // Moto edge 70: 406x904dp, a tall phone, must rotate freely.
        assertFalse(LayoutChooser.shouldPreferLandscape(406))
        assertFalse(LayoutChooser.shouldPreferLandscape(599))
        assertTrue(LayoutChooser.shouldPreferLandscape(600))
        assertTrue(LayoutChooser.shouldPreferLandscape(800))
    }
}
