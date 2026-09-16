package com.potatomotato.helm.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What a detail screen's app bar is allowed to call the thing it has open.
 *
 * The failure this pins is a bar that renders blank — either because the record
 * has not landed yet, or because it landed with no title of its own.
 */
class DetailTitleTest {

    @Test
    fun `a loaded record names itself`() {
        assertEquals("Ship the thing", detailTitle(LoadView.Ready("Ship the thing", false), "Plan") { it })
    }

    @Test
    fun `a record still arriving falls back to the kind`() {
        assertEquals("Plan", detailTitle(LoadView.Loading, "Plan") { _: String -> "unused" })
    }

    @Test
    fun `a failed read still names the kind rather than showing the error twice`() {
        // The message belongs in the body, where it has room; the bar only has
        // to say which screen this is.
        assertEquals("Plan", detailTitle(LoadView.Failed("link dropped"), "Plan") { _: String -> "unused" })
    }

    @Test
    fun `a record with a blank title falls back too`() {
        // An empty app bar reads as a rendering bug, not as an untitled record.
        assertEquals("Context", detailTitle(LoadView.Ready("   ", false), "Context") { it })
    }
}
