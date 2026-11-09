package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.TabletPaneHeightStore
import com.potatomotato.helm.ui.theme.HelmColors

@Composable
internal fun TabletSplitter(
    store: TabletPaneHeightStore,
    sessions: @Composable (Modifier) -> Unit,
    todos: @Composable (Modifier) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val controller = remember(store) { TabletSplitterController(store) }
    var todoHeightDp by remember(store) {
        mutableFloatStateOf(controller.initialTodoHeightDp())
    }

    androidx.compose.foundation.layout.BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val totalHeightDp = maxHeight.value
        val clampedTodoHeightDp = TabletSplitterPolicy.clampTodoHeight(todoHeightDp, totalHeightDp)
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth()) { sessions(Modifier.fillMaxSize()) }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(TabletSplitterPolicy.HANDLE_HEIGHT_DP.dp)
                    .pointerInput(totalHeightDp, density) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            todoHeightDp = controller.resize(
                                requestedDp = todoHeightDp - dragAmount.y / density.density,
                                totalHeightDp = totalHeightDp,
                            )
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(HelmColors.Line))
            }
            Box(Modifier.fillMaxWidth().height(clampedTodoHeightDp.dp)) { todos(Modifier.fillMaxSize()) }
        }
    }
}
