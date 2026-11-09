package com.potatomotato.helm.ui.tablet

import com.potatomotato.helm.data.TabletPaneHeightStore

internal object TabletSplitterPolicy {
    const val DEFAULT_TODO_HEIGHT_DP = 220f
    const val MIN_TODO_HEIGHT_DP = 112f
    const val MIN_SESSION_HEIGHT_DP = 180f
    const val HANDLE_HEIGHT_DP = 10f

    fun clampTodoHeight(
        requestedDp: Float,
        totalHeightDp: Float,
        minTodoHeightDp: Float = MIN_TODO_HEIGHT_DP,
        minSessionHeightDp: Float = MIN_SESSION_HEIGHT_DP,
        handleHeightDp: Float = HANDLE_HEIGHT_DP,
    ): Float {
        val total = totalHeightDp.takeIf(Float::isFinite)?.coerceAtLeast(0f) ?: 0f
        val available = (total - handleHeightDp.coerceAtLeast(0f)).coerceAtLeast(0f)
        val minimumTodo = minTodoHeightDp.coerceAtLeast(0f).coerceAtMost(available)
        val minimumSessions = minSessionHeightDp.coerceAtLeast(0f).coerceAtMost(available - minimumTodo)
        val maximumTodo = (available - minimumSessions).coerceAtLeast(minimumTodo)
        val requested = requestedDp.takeIf(Float::isFinite) ?: DEFAULT_TODO_HEIGHT_DP
        return requested.coerceIn(minimumTodo, maximumTodo)
    }
}

/** Applies splitter changes through the same clamp used at layout time, then persists the result. */
internal class TabletSplitterController(private val store: TabletPaneHeightStore) {
    fun initialTodoHeightDp(): Float =
        store.loadTodoHeightDp() ?: TabletSplitterPolicy.DEFAULT_TODO_HEIGHT_DP

    fun resize(requestedDp: Float, totalHeightDp: Float): Float {
        val height = TabletSplitterPolicy.clampTodoHeight(requestedDp, totalHeightDp)
        store.saveTodoHeightDp(height)
        return height
    }
}
