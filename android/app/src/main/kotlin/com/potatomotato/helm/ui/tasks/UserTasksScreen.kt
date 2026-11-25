package com.potatomotato.helm.ui.tasks

import android.content.ActivityNotFoundException
import android.content.Intent
import android.widget.Toast
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import com.potatomotato.helm.data.UserTaskAttachmentAction
import com.potatomotato.helm.save.AndroidArtifactFiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items as listItems
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.UserTaskBoardState
import com.potatomotato.helm.data.UserTaskChecklistItem
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
private val TINTS = HelmColors.NoteTints
private val AI_EDGE = HelmColors.NoteAiEdge
private val NOTE_INK = HelmColors.NoteInk
private val DONE_GREEN = HelmColors.NoteDone
/** Mirrors USER_TASK_CHECKLIST_MAX on the desktop. */
private const val CHECKLIST_MAX = 50

internal fun tintIndex(projectId: String?): Int {
    if (projectId.isNullOrEmpty()) return 0
    var hash = 0
    for (ch in projectId) hash = hash * 31 + ch.code
    return 1 + Math.floorMod(hash, TINTS.size - 1)
}

/**
 * The user's task board, grouped by project like the desktop. Phone and
 * tablet alike: the listing, tap a note for its full-screen detail, Back
 * returns to the listing at the same scroll position.
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
    var confirmClearDone by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { client.refresh() }

    val rows = when (val b = board) {
        is UserTaskBoardState.Ready -> b.rows
        is UserTaskBoardState.Failed -> b.rows
        else -> emptyList()
    }
    val visible = rows.filter { filter.matches(it) }
    val select: (UserTaskRow) -> Unit = { selectedId = it.id; client.open(it.id) }

    // One model on phone and tablet: the listing, or one task's detail; Back returns.
    val gridState = rememberLazyGridState()
    BackHandler(enabled = selectedId != null) { selectedId = null }
    Box(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        if (selectedId != null) {
            val detail = details[selectedId!!]
            if (detail == null) Hint("Loading…")
            else TaskDetailBody(detail, projectName, client, onClosed = { selectedId = null })
        } else BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val columns = if (maxWidth >= 720.dp) 4 else 2
            Column(modifier = Modifier.fillMaxSize()) {
                FilterRow(filter, rows.count { !it.done }, rows.count { it.done }, onClearDone = { confirmClearDone = true }) { filter = it }
                if (writeError != null) {
                    Text(
                        text = writeError!!,
                        color = HelmColors.Danger,
                        modifier = Modifier.fillMaxWidth().clickable { client.state.clearWriteError() }.padding(HelmSpacing.Md),
                    )
                }
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        board is UserTaskBoardState.Loading -> Hint("Loading tasks…")
                        board is UserTaskBoardState.Failed && rows.isEmpty() ->
                            Hint("Could not load tasks: ${(board as UserTaskBoardState.Failed).message}")
                        visible.isEmpty() -> Hint(if (filter == TaskFilter.Done) "Nothing done yet" else "Nothing for you to do 🎉")
                        else -> TaskGrid(visible, projectName, gridState, columns, select)
                    }
                    Box(
                        modifier = Modifier.align(Alignment.BottomEnd).padding(HelmSpacing.Lg).size(52.dp)
                            .background(HelmColors.Accent, CircleShape).clickable { adding = true },
                        contentAlignment = Alignment.Center,
                    ) { Text("+", color = HelmColors.OnAccent, style = MaterialTheme.typography.headlineSmall) }
                }
            }
        }
    }

    if (confirmClearDone) {
        val doneCount = rows.count { it.done }
        AlertDialog(
            onDismissRequest = { confirmClearDone = false },
            title = { Text("Clear done tasks?") },
            text = { Text("$doneCount done task${if (doneCount == 1) "" else "s"} and their attachments will be removed.") },
            confirmButton = { TextButton(onClick = { client.deleteDone(); confirmClearDone = false }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmClearDone = false }) { Text("Cancel") } },
        )
    }
    if (adding) AddTaskDialog(onDismiss = { adding = false }) { title, body, urgent ->
        client.add(title, body, urgent)
        adding = false
    }
    AttachmentHandler(client)
}

@Composable
private fun FilterRow(filter: TaskFilter, openCount: Int, doneCount: Int, onClearDone: () -> Unit, onPick: (TaskFilter) -> Unit) {
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
        if (filter == TaskFilter.Done && doneCount > 0) {
            Text(
                text = "Clear done ($doneCount)",
                color = HelmColors.Danger,
                modifier = Modifier
                    .border(1.dp, HelmColors.Danger, RoundedCornerShape(50))
                    .clickable(onClick = onClearDone)
                    .padding(horizontal = 12.dp, vertical = 5.dp),
            )
        }
    }
}

@Composable
private fun TaskGrid(
    rows: List<UserTaskRow>,
    projectName: (String) -> String?,
    state: LazyGridState,
    columns: Int,
    onSelect: (UserTaskRow) -> Unit,
) {
    // Project groups; urgent groups first, General last.
    val groups = rows.groupBy { it.projectId }.entries.sortedWith(
        compareBy<Map.Entry<String?, List<UserTaskRow>>>({ it.key == null }, { e -> if (e.value.any { it.urgent }) 0 else 1 }, { it.key?.let(projectName) ?: "" }),
    )
    LazyVerticalGrid(
        columns = GridCells.Fixed(columns),
        state = state,
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
            items(tasks, key = { it.id }) { row -> Note(row) { onSelect(row) } }
        }
    }
}

@Composable
private fun Note(row: UserTaskRow, onClick: () -> Unit) {
    val tint = TINTS[tintIndex(row.projectId)]
    Column(
        modifier = Modifier.fillMaxWidth().heightIn(min = 92.dp)
            .background(tint.copy(alpha = if (row.done) 0.45f else 1f), RoundedCornerShape(4.dp))
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
            if (row.excerpt.isNotBlank()) {
                Text(row.excerpt, color = NOTE_INK.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.heightIn(min = 8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text((if (row.byUser) "🧑 you" else "🤖 ${row.author}"), color = NOTE_INK.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (row.attachments > 0) Text("📎${row.attachments}", color = NOTE_INK.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall)
                if (row.checklistTotal > 0) {
                    Text(
                        "☑ ${row.checklistDone}/${row.checklistTotal}",
                        color = NOTE_INK.copy(alpha = 0.8f),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.background(NOTE_INK.copy(alpha = 0.12f), RoundedCornerShape(8.dp)).padding(horizontal = 6.dp),
                    )
                }
            }
        }
    }
}

/** Body text longer than this starts collapsed so the checklist stays near the top. */
private const val CLAMP_LINES = 5

/** Header and action bar stay put; the middle scrolls, with the checklist heading pinned. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TaskDetailBody(
    detail: UserTaskDetail,
    projectName: (String) -> String?,
    client: UserTaskClient,
    onClosed: () -> Unit,
) {
    var editing by remember(detail.id) { mutableStateOf(false) }
    var confirmDelete by remember(detail.id) { mutableStateOf(false) }
    var expanded by remember(detail.id) { mutableStateOf(false) }
    var overflowing by remember(detail.id) { mutableStateOf(false) }
    var newItem by remember(detail.id) { mutableStateOf("") }
    val fmt = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    val ticked = detail.checklist.count { it.done }
    val total = detail.checklist.size
    val done = detail.doneAt != null
    val keep: (String?) -> List<UserTaskChecklistItem> = { except -> detail.checklist.filter { it.id != except } }
    Column(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(HelmSpacing.Lg)) {
            Text("← Tasks", color = HelmColors.Accent, modifier = Modifier.clickable(onClick = onClosed).padding(bottom = HelmSpacing.Sm))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(10.dp).background(TINTS[tintIndex(detail.projectId)], CircleShape))
                Text((if (detail.urgent) "❗ " else "") + detail.title, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium)
            }
            Text(
                text = (detail.projectId?.let(projectName) ?: "General") + (detail.doneAt?.let { " · done ${fmt.format(Date(it))}" } ?: ""),
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = HelmSpacing.Lg, vertical = HelmSpacing.Md),
        ) {
            if (detail.body.isNotBlank()) item(key = "body") {
                Column {
                    Text(
                        detail.body,
                        color = HelmColors.Txt,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = if (expanded) Int.MAX_VALUE else CLAMP_LINES,
                        overflow = TextOverflow.Ellipsis,
                        onTextLayout = { if (!expanded) overflowing = it.hasVisualOverflow },
                    )
                    if (overflowing || expanded) {
                        Text(
                            if (expanded) "Show less ▴" else "Show more ▾",
                            color = HelmColors.Accent,
                            modifier = Modifier.clickable { expanded = !expanded }.padding(vertical = HelmSpacing.Xs),
                        )
                    }
                }
            }
            if (total > 0 || !done) {
                stickyHeader(key = "checklist-head") {
                    Column(modifier = Modifier.fillMaxWidth().background(HelmColors.Bg).padding(vertical = HelmSpacing.Sm)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Checklist", color = HelmColors.Dim, style = MaterialTheme.typography.labelLarge)
                            if (total > 0) Text("$ticked / $total", color = HelmColors.Dim, style = MaterialTheme.typography.labelLarge)
                        }
                        if (total > 0) {
                            Box(Modifier.padding(top = 4.dp).fillMaxWidth().heightIn(min = 4.dp, max = 4.dp).background(HelmColors.Surface2, RoundedCornerShape(2.dp))) {
                                Box(Modifier.fillMaxWidth(ticked.toFloat() / total).heightIn(min = 4.dp, max = 4.dp).background(DONE_GREEN, RoundedCornerShape(2.dp)))
                            }
                        }
                    }
                }
                listItems(detail.checklist, key = { "i:${it.id}" }) { item ->
                    Row(
                        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { client.check(detail.id, item.id, !item.done) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = item.done, onCheckedChange = { client.check(detail.id, item.id, it) })
                        Text(
                            item.text,
                            color = if (item.done) HelmColors.Dim else HelmColors.Txt,
                            textDecoration = if (item.done) TextDecoration.LineThrough else null,
                            modifier = Modifier.weight(1f),
                        )
                        Text("✕", color = HelmColors.Faint, modifier = Modifier.clickable { client.setChecklist(detail.id, keep(item.id)) }.padding(HelmSpacing.Sm))
                    }
                }
                if (total < CHECKLIST_MAX) item(key = "add") {
                    OutlinedTextField(
                        value = newItem,
                        onValueChange = { newItem = it.take(200) },
                        placeholder = { Text("＋ Add item") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(top = HelmSpacing.Xs),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = {
                            if (newItem.isNotBlank()) {
                                client.setChecklist(detail.id, keep(null) + UserTaskChecklistItem("", newItem.trim(), false))
                                newItem = ""
                            }
                        }),
                    )
                }
            }
            item(key = "meta") {
                Column(modifier = Modifier.padding(top = HelmSpacing.Md)) {
                    Meta("From", if (detail.aiName != null) "🤖 ${detail.aiName}${detail.aiCli?.let { " ($it)" } ?: ""}" else "🧑 you")
                    detail.aiDir?.let { Meta("Folder", it, mono = true) }
                    Meta("Created", fmt.format(Date(detail.createdAt)))
                }
            }
            if (detail.attachments.isNotEmpty()) {
                item(key = "att-head") {
                    Text("Attachments", color = HelmColors.Dim, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = HelmSpacing.Md))
                }
                listItems(detail.attachments, key = { "a:${it.id}" }) { a ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = HelmSpacing.Xs)
                            .background(HelmColors.Surface2, RoundedCornerShape(6.dp))
                            .clickable { client.fetchAttachment(detail.id, a.id, UserTaskAttachmentAction.Open) }
                            .padding(start = HelmSpacing.Sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text((when (a.kind) { "plan" -> "🗺 "; "artifact" -> "📄 "; else -> "📎 " }) + a.title, color = HelmColors.Txt, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        TextButton(onClick = { client.fetchAttachment(detail.id, a.id, UserTaskAttachmentAction.Save) }) { Text("Save", color = HelmColors.Accent) }
                        TextButton(onClick = { client.fetchAttachment(detail.id, a.id, UserTaskAttachmentAction.Open) }) { Text("Open", color = HelmColors.Accent) }
                    }
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).border(1.dp, HelmColors.Line).padding(horizontal = HelmSpacing.Lg, vertical = HelmSpacing.Sm),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = { confirmDelete = true }) { Text("Delete", color = HelmColors.Danger) }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { editing = true }) { Text("Edit", color = HelmColors.Txt) }
            val ready = !done && total > 0 && ticked == total
            Text(
                text = if (done) "Reopen" else "✓ Done",
                color = HelmColors.OnAccent,
                modifier = Modifier
                    .then(if (ready) Modifier.border(3.dp, DONE_GREEN.copy(alpha = 0.5f), RoundedCornerShape(8.dp)) else Modifier)
                    .background(HelmColors.Accent, RoundedCornerShape(6.dp))
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

/**
 * Fetched bytes leave the app here: Open hands a private cache copy to whatever
 * the device uses for that type (full screen, the user's own app); Save keeps a
 * copy in Downloads through the same sink artifacts use. Each fetch is handled once.
 */
@Composable
private fun AttachmentHandler(client: UserTaskClient) {
    val content by client.state.attachment.collectAsState()
    val context = LocalContext.current
    val files = remember(context) { AndroidArtifactFiles(context) }
    LaunchedEffect(content) {
        val fetched = content ?: return@LaunchedEffect
        val mime = fetched.info.contentType.ifBlank { "application/octet-stream" }
        val name = attachmentFileName(fetched.info.title)
        val message = try {
            when (fetched.action) {
                UserTaskAttachmentAction.Save -> withContext(Dispatchers.IO) {
                    "Saved ${files.save(name, mime, ByteArrayInputStream(fetched.bytes)).location}"
                }
                UserTaskAttachmentAction.Open -> {
                    val file = withContext(Dispatchers.IO) {
                        val dir = File(context.cacheDir, ATTACHMENT_CACHE).apply { deleteRecursively(); mkdirs() }
                        File(dir, name).apply { writeBytes(fetched.bytes) }
                    }
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    null
                }
            }
        } catch (error: ActivityNotFoundException) {
            "No app on this device opens $mime"
        } catch (error: IOException) {
            "Could not write ${fetched.info.title}: ${error.message}"
        }
        if (message != null) Toast.makeText(context, message, Toast.LENGTH_LONG).show()
        // Cleared only now: clearing first re-keys this effect and cancels the
        // save before its toast — the file landed but the user never heard.
        client.state.attachmentHandled()
    }
}

/** A device-safe filename; the title is AI-authored and may hold path characters. */
internal fun attachmentFileName(title: String): String =
    title.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().take(80).ifEmpty { "attachment" }

private const val ATTACHMENT_CACHE = "user-task-attachments"

@Composable
private fun Hint(text: String) {
    Box(modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl), contentAlignment = Alignment.Center) {
        Text(text, color = HelmColors.Faint)
    }
}
