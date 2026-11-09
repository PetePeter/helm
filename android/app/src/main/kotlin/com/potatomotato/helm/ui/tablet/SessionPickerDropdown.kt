package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.sessions.SessionRows
import com.potatomotato.helm.ui.sessions.SessionRowsContent

@Composable
internal fun SessionPickerDropdown(
    expanded: Boolean,
    sessions: List<HelmSession>,
    unread: Map<String, Int>,
    contextHistories: Map<String, ContextHistory>,
    selectedId: String?,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var collapsedList by rememberSaveable { mutableStateOf(listOf<String>()) }
    val collapsed = collapsedList.toSet()
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        modifier = Modifier.widthIn(min = 320.dp, max = 520.dp).heightIn(max = 560.dp),
    ) {
        SessionRowsContent(
            sessions = sessions,
            unread = unread,
            contextHistories = contextHistories,
            collapsedGroups = collapsed,
            selectedId = selectedId,
            onToggleGroup = { label -> collapsedList = SessionRows.toggle(collapsed, label).toList() },
            onOpen = { onSelect(it.id) },
            onLongPress = {},
            modifier = Modifier.heightIn(max = 540.dp),
        )
    }
}
