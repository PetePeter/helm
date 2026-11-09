package com.potatomotato.helm.ui.tablet

import com.potatomotato.helm.data.TabletPaneHeightStore
import org.junit.Assert.assertEquals
import org.junit.Test

class TabletSplitterPolicyTest {
    @Test fun todoHeightClampsAtBothBounds() {
        assertEquals(112f, TabletSplitterPolicy.clampTodoHeight(40f, 800f), 0f)
        assertEquals(610f, TabletSplitterPolicy.clampTodoHeight(900f, 800f), 0f)
    }

    @Test fun shortWindowNeverProducesNegativePaneHeight() {
        val result = TabletSplitterPolicy.clampTodoHeight(220f, 100f)
        assertEquals(90f, result, 0f)
    }

    @Test fun paneHeightStorePersistsTheLatestDrag() {
        val store = FakeTabletPaneHeightStore()
        val controller = TabletSplitterController(store)
        assertEquals(TabletSplitterPolicy.DEFAULT_TODO_HEIGHT_DP, controller.initialTodoHeightDp(), 0f)

        assertEquals(300f, controller.resize(300f, 800f), 0f)
        assertEquals(400f, controller.resize(400f, 800f), 0f)

        assertEquals(400f, store.loadTodoHeightDp()!!, 0f)
    }

    private class FakeTabletPaneHeightStore : TabletPaneHeightStore {
        private var height: Float? = null
        override fun loadTodoHeightDp(): Float? = height
        override fun saveTodoHeightDp(heightDp: Float) { height = heightDp }
    }
}
