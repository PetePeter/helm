package com.potatomotato.helm.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Back on the root retraces the picker's tabs before it offers to exit. */
class HomeTabHistoryTest {

    @Test
    fun `back from a picked tab returns to the one before it`() {
        val history = HomeTabHistory().pick(HomeTab.Sessions, HomeTab.Helm)

        val (tab, rest) = history.back()!!

        assertEquals(HomeTab.Sessions, tab)
        assertNull(rest.back())
    }

    @Test
    fun `re-picking the showing tab adds no step`() {
        assertNull(HomeTabHistory().pick(HomeTab.Helm, HomeTab.Helm).back())
    }

    @Test
    fun `a tab already in the trail is not visited twice on the way back`() {
        val history = HomeTabHistory()
            .pick(HomeTab.Sessions, HomeTab.Helm)
            .pick(HomeTab.Helm, HomeTab.Sessions)
            .pick(HomeTab.Sessions, HomeTab.Plans)

        val (first, rest) = history.back()!!
        val (second, end) = rest.back()!!

        assertEquals(HomeTab.Sessions, first)
        assertEquals(HomeTab.Helm, second)
        assertNull(end.back())
    }
}
