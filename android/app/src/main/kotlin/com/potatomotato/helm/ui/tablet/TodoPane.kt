package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.SessionTodo
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.keyboard.LocalKeyboardFocusState
import com.potatomotato.helm.ui.keyboard.keyboardFocusTarget
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

@Composable
internal fun TodoPane(todos: List<SessionTodo>, modifier: Modifier = Modifier) {
    val keyboardFocus = LocalKeyboardFocusState.current
    Column(
        modifier = modifier.fillMaxSize()
            .keyboardFocusTarget(keyboardFocus?.todoPaneRequester)
            .background(HelmColors.Surface),
    ) {
        Hairline()
        Text(
            text = "✓ ${todos.size} open",
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        )
        if (todos.isEmpty()) {
            Text(
                text = "No open todos",
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
            )
        } else LazyColumn(modifier = Modifier.fillMaxWidth()) {
            items(todos, key = { it.id }) { todo ->
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(todo.text, color = HelmColors.Txt, style = MaterialTheme.typography.bodySmall)
                    if (todo.waiting) {
                        Text("· waiting on you", color = HelmColors.State.Waiting, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
