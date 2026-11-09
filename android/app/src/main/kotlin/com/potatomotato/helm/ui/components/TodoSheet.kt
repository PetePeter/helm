package com.potatomotato.helm.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.SessionTodo
import com.potatomotato.helm.ui.keyboard.keyboardPttEvents
import com.potatomotato.helm.ui.tablet.TodoPane
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TodoSheet(todos: List<SessionTodo>, onDismiss: () -> Unit) {
    ModalBottomSheet(
        modifier = Modifier.keyboardPttEvents(),
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = HelmColors.Surface,
    ) {
        TodoPane(
            todos = todos,
            modifier = Modifier.fillMaxWidth().heightIn(max = 480.dp).padding(bottom = HelmSpacing.Xl),
        )
    }
}
