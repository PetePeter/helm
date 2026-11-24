package com.potatomotato.helm.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.UserTaskBoardState
import com.potatomotato.helm.data.UserTaskDetail
import com.potatomotato.helm.data.UserTaskRow
import com.potatomotato.helm.link.UserTaskClient
import com.potatomotato.helm.ui.artifacts.ContainedWebView
import com.potatomotato.helm.ui.components.MarkdownText
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing
import java.text.DateFormat
import java.util.Date

/** Filters mirror the desktop pane: done never mixes into the open views. */
internal enum class TaskFilter(val label: String) { All("All"), Mine("Mine"), Ai("AI"), Urgent("Urgent"), Done("Done") }

internal fun TaskFilter.matches(row: UserTaskRow): Boolean = when (this) {
    TaskFilter.Done -> row.done
    TaskFilter.All -> !row.done
    TaskFilter.Mine -> !row.done && row.byUser
    TaskFilter.Ai -> !row.done && !row.byUser
    TaskFilter.Urgent -> !row.done && row.urgent
}

/** Post-it tints; index 0 is "General" (no project). Derived from the project, never stored. */
private val TINTS = listOf(Color(0xFFFFE680), Color(0xFFFFB3C7), Color(0xFFB6F0B1), Color(0xFFA9D4FF), Color(0xFFFFC98A))
private val AI_EDGE = Color(0xFF6E40C9)
private val NOTE_INK = Color(0xFF1B1B1B)

internal fun tintIndex(projectId: String?): Int {
    if (projectId.isNullOrEmpty()) return 0
    var hash = 0
    for (ch in projectId) hash = hash * 31 + ch.code
    return 1 + Math.floorMod(hash, TINTS.size - 1)
}

/**
 * The user's task board. Phone: grid + bottom-sheet detail. Wide (tablet):
 * grid + docked detail panel. Grouped by project like the desktop.
 */
@Composable
fun UserTasksScreen(
    client: UserTaskClient,
    projectName: (String) -> String?,
    modifier: Modifier = Modifier,
) {
    val board by client.state.board.collectAsState()
    val details by client.state.details.collectAsState()
    val writeError by client.state.writeError.collectAsState()
    var filter by rememberSaveable { mutableStateOf(TaskFilter.All) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { client.refresh() }

    val rows = when (val b = board) {
        is UserTaskBoardState.Ready -> b.rows
        is UserTaskBoardState.Failed -> b.rows
        else -> emptyList()
    }
    val visible = rows.filter { filter.matches(it) }
    val select: (UserTaskRow) -> Unit = { selectedId = it.id; client.open(it.id) }

    BoxWithConstraints(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        val wide = maxWidth >= 720.dp
        Row(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                FilterRow(filter, rows.count { !it.done }) { filter = it }
                if (writeError != null) {
                    Text(
                        text = writeError!!,
                        color = Color(0xFFFF6B6B),
                        modifier = Modifier.fillMaxWidth().clickable { client.state.clearWriteError() }.padding(HelmSpacing.Md),
                    )
                }
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        board is UserTaskBoardState.Loading -> Hint("Loading tasks…")
                        board is UserTaskBoardState.Failed && rows.isEmpty() ->
                            Hint("Could not load tasks: ${(board as UserTaskBoardState.Failed).message}")
                        visible.isEmpty() -> Hint(if (filter == TaskFilter.Done) "Nothing done yet" else "Nothing for you to do 🎉")
                        else -> TaskGrid(visible, projectName, selectedId.takeIf { wide }, if (wide) 4 else 2, select)
                    }
                    Box(
                        modifier = Modifier.align(Alignment.BottomEnd).padding(HelmSpacing.Lg).size(52.dp)
                            .background(HelmColors.Accent, CircleShape).clickable { adding = true },
                        contentAlignment = Alignment.Center,
                    ) { Text("+", color = HelmColors.OnAccent, style = MaterialTheme.typography.headlineSmall) }
                }
            }
            if (wide) {
                Column(
                    modifier = Modifier.width(320.dp).fillMaxHeight().background(HelmColors.Surface)
                        .border(1.dp, HelmColors.Line),
                ) {
                    val detail = selectedId?.let { details[it] }
                    if (detail == null) Hint(if (selectedId == null) "Select a task" else "Loading…")
                    else TaskDetailBody(detail, projectName, client, onClosed = { selectedId = null })
                }
            }
        }
        if (!wide && selectedId != null) {
            TaskDetailSheet(details[selectedId!!], projectName, client) { selectedId = null }
        }
    }

    if (adding) AddTaskDialog(onDismiss = { adding = false }) { title, body, urgent ->
        client.add(title, body, urgent)
        adding = false
    }
    AttachmentViewer(client)
}

@Composable
private fun FilterRow(filter: TaskFilter, openCount: Int, onPick: (TaskFilter) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        TaskFilter.entries.forEach { f ->
            val on = f == filter
            Text(
                text = if (f == TaskFilter.All && openCount > 0) "${f.label} $openCount" else f.label,
                color = if (on) HelmColors.OnAccent else HelmColors.Dim,
                modifier = Modifier
                    .background(if (on) HelmColors.Accent else HelmColors.Surface2, RoundedCornerShape(50))
                    .clickable { onPick(f) }
                    .padding(horizontal = 12.dp, vertical = 5.dp),
            )
        }
    }
}

@Composable
private fun TaskGrid(
    rows: List<UserTaskRow>,
    projectName: (String) -> String?,
    selectedId: String?,
    columns: Int,
    onSelect: (UserTaskRow) -> Unit,
) {
    // Project groups; urgent groups first, General last.
    val groups = rows.groupBy { it.projectId }.entries.sortedWith(
        compareBy<Map.Entry<String?, List<UserTaskRow>>>({ it.key == null }, { e -> if (e.value.any { it.urgent }) 0 else 1 }, { it.key?.let(projectName) ?: "" }),
    )
    LazyVerticalGrid(
        columns = GridCells.Fixed(columns),
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(HelmSpacing.Md),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        groups.forEach { (projectId, tasks) ->
            item(span = { GridItemSpan(maxLineSpan) }, key = "h:${projectId ?: ""}") {
                Text(
                    text = "${projectId?.let(projectName) ?: if (projectId == null) "General" else "Unknown project"} · ${tasks.size}",
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(top = HelmSpacing.Sm),
                )
            }
            items(tasks, key = { it.id }) { row -> Note(row, row.id == selectedId) { onSelect(row) } }
        }
    }
}

@Composable
private fun Note(row: UserTaskRow, selected: Boolean, onClick: () -> Unit) {
    val tint = TINTS[tintIndex(row.projectId)]
    Column(
        modifier = Modifier.fillMaxWidth().heightIn(min = 92.dp)
            .background(tint.copy(alpha = if (row.done) 0.45f else 1f), RoundedCornerShape(4.dp))
            .then(if (selected) Modifier.border(3.dp, HelmColors.Accent, RoundedCornerShape(4.dp)) else Modifier)
            .then(if (!row.byUser) Modifier.border(width = 0.dp, color = Color.Transparent) else Modifier)
            .clickable(onClick = onClick),
    ) {
        if (!row.byUser) Box(Modifier.fillMaxWidth().heightIn(min = 3.dp).background(AI_EDGE))
        Column(modifier = Modifier.padding(9.dp)) {
            Text(
                text = (if (row.urgent) "❗ " else "") + row.title,
                color = NOTE_INK,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (row.done) TextDecoration.LineThrough else null,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.heightIn(min = 8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text((if (row.byUser) "🧑 you" else "🤖 ${row.author}"), color = NOTE_INK.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (row.attachments > 0) Text("📎${row.attachments}", color = NOTE_INK.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskDetailSheet(
    detail: UserTaskDetail?,
    projectName: (String) -> String?,
    client: UserTaskClient,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = HelmColors.Surface,
    ) {
        Box(modifier = Modifier.fillMaxWidth().heightIn(min = 200.dp, max = 620.dp).padding(bottom = HelmSpacing.Xl)) {
            if (detail == null) Hint("Loading…") else TaskDetailBody(detail, projectName, client, onClosed = onDismiss)
        }
    }
}

@Composable
private fun TaskDetailBody(
    detail: UserTaskDetail,
    projectName: (String) -> String?,
    client: UserTaskClient,
    onClosed: () -> Unit,
) {
    var editing by remember(detail.id) { mutableStateOf(false) }
    var confirmDelete by remember(detail.id) { mutableStateOf(false) }
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(HelmSpacing.Lg)) {
        Text((if (detail.urgent) "❗ " else "") + detail.title, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium)
        Text(
            text = (detail.projectId?.let(projectName) ?: "General") + (detail.doneAt?.let { " · done ${fmt.format(Date(it))}" } ?: ""),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.labelMedium,
        )
        if (detail.body.isNotBlank()) {
            Spacer(Modifier.heightIn(min = HelmSpacing.Md))
            Text(detail.body, color = HelmColors.Txt, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.heightIn(min = HelmSpacing.Md))
        Meta("From", if (detail.aiName != null) "🤖 ${detail.aiName}${detail.aiCli?.let { " ($it)" } ?: ""}" else "🧑 you")
        detail.aiDir?.let { Meta("Folder", it, mono = true) }
        Meta("Created", fmt.format(Date(detail.createdAt)))
        if (detail.attachments.isNotEmpty()) {
            Spacer(Modifier.heightIn(min = HelmSpacing.Md))
            Text("Attachments", color = HelmColors.Dim, style = MaterialTheme.typography.labelLarge)
            detail.attachments.forEach { a ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = HelmSpacing.Xs)
                        .background(HelmColors.Surface2, RoundedCornerShape(6.dp))
                        .clickable { client.openAttachment(detail.id, a.id) }
                        .padding(HelmSpacing.Sm),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text((when (a.kind) { "plan" -> "🗺 "; "artifact" -> "📄 "; else -> "📎 " }) + a.title, color = HelmColors.Txt, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Open", color = HelmColors.Accent)
                }
            }
        }
        Spacer(Modifier.heightIn(min = HelmSpacing.Lg))
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { confirmDelete = true }) { Text("Delete", color = Color(0xFFFF6B6B)) }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { editing = true }) { Text("Edit", color = HelmColors.Txt) }
            val done = detail.doneAt != null
            Text(
                text = if (done) "Reopen" else "✓ Done",
                color = HelmColors.OnAccent,
                modifier = Modifier.background(HelmColors.Accent, RoundedCornerShape(6.dp))
                    .clickable { client.setDone(detail.id, !done); onClosed() }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
    if (editing) {
        AddTaskDialog(
            initialTitle = detail.title,
            initialBody = detail.body,
            initialUrgent = detail.urgent,
            confirmLabel = "Save",
            onDismiss = { editing = false },
        ) { title, body, urgent ->
            client.edit(detail.id, title, body, urgent)
            editing = false
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete task?") },
            text = { Text("“${detail.title}” and its attachments will be removed.") },
            confirmButton = { TextButton(onClick = { client.delete(detail.id); confirmDelete = false; onClosed() }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Meta(label: String, value: String, mono: Boolean = false) {
    Row(modifier = Modifier.padding(vertical = 2.dp)) {
        Text(label, color = HelmColors.Dim, modifier = Modifier.width(72.dp), style = MaterialTheme.typography.bodySmall)
        Text(value, color = HelmColors.Txt, style = MaterialTheme.typography.bodySmall.let { if (mono) it.copy(fontFamily = FontFamily.Monospace) else it })
    }
}

@Composable
private fun AddTaskDialog(
    initialTitle: String = "",
    initialBody: String = "",
    initialUrgent: Boolean = false,
    confirmLabel: String = "Add",
    onDismiss: () -> Unit,
    onConfirm: (String, String, Boolean) -> Unit,
) {
    var title by rememberSaveable { mutableStateOf(initialTitle) }
    var body by rememberSaveable { mutableStateOf(initialBody) }
    var urgent by rememberSaveable { mutableStateOf(initialUrgent) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = HelmColors.Surface,
        title = { Text(if (confirmLabel == "Add") "New task" else "Edit task", color = HelmColors.Txt) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm)) {
                OutlinedTextField(value = title, onValueChange = { title = it.take(200) }, label = { Text("What do you need to do?") }, singleLine = true, keyboardOptions = KeyboardOptions.Default)
                OutlinedTextField(value = body, onValueChange = { body = it.take(4000) }, label = { Text("Details (optional)") }, minLines = 3)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { urgent = !urgent }) {
                    Checkbox(checked = urgent, onCheckedChange = { urgent = it })
                    Text("Urgent", color = HelmColors.Txt)
                }
            }
        },
        confirmButton = { TextButton(enabled = title.isNotBlank(), onClick = { onConfirm(title.trim(), body.trim(), urgent) }) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Markdown renders natively; HTML only inside the contained WebView; binaries stay on the desktop. */
@Composable
private fun AttachmentViewer(client: UserTaskClient) {
    val content by client.state.attachment.collectAsState()
    val open = content ?: return
    AlertDialog(
        onDismissRequest = { client.state.closeAttachment() },
        containerColor = HelmColors.Surface,
        title = { Text(open.info.title, color = HelmColors.Txt, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 520.dp)) {
                when {
                    open.text == null -> Text("${open.info.contentType} — open it on the desktop.", color = HelmColors.Dim)
                    open.info.contentType == "text/html" -> ContainedWebView(html = open.text, modifier = Modifier.fillMaxSize())
                    open.info.contentType == "text/markdown" ->
                        Column(Modifier.verticalScroll(rememberScrollState())) { MarkdownText(open.text) }
                    else -> Column(Modifier.verticalScroll(rememberScrollState())) {
                        Text(open.text, color = HelmColors.Txt, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { client.state.closeAttachment() }) { Text("Close") } },
    )
}

@Composable
private fun Hint(text: String) {
    Box(modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl), contentAlignment = Alignment.Center) {
        Text(text, color = HelmColors.Faint)
    }
}
