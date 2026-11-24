package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** One board note, as `user_task_list` rows it (docs/user-tasks.md). */
data class UserTaskRow(
    val id: String,
    val title: String,
    val urgent: Boolean,
    val projectId: String?,
    val author: String,
    val attachments: Int,
    val createdAt: Long,
    val doneAt: Long?,
    /** Ticked / total; total 0 means no checklist. */
    val checklistDone: Int = 0,
    val checklistTotal: Int = 0,
    val excerpt: String = "",
) {
    val done: Boolean get() = doneAt != null
    val byUser: Boolean get() = author == "you"
}

data class UserTaskAttachmentInfo(
    val id: String,
    val kind: String,
    val title: String,
    val contentType: String,
    val sizeBytes: Long,
)

/** One tickable step; order is the author's. */
data class UserTaskChecklistItem(val id: String, val text: String, val done: Boolean)

/** The full task from `user_task_get`. An AI author is a snapshot; its session may be gone. */
data class UserTaskDetail(
    val id: String,
    val title: String,
    val body: String,
    val urgent: Boolean,
    val projectId: String?,
    val aiName: String?,
    val aiCli: String?,
    val aiDir: String?,
    val attachments: List<UserTaskAttachmentInfo>,
    val checklist: List<UserTaskChecklistItem>,
    val createdAt: Long,
    val updatedAt: Long,
    val doneAt: Long?,
)

/** An attachment's bytes: text as-is, anything else base64 (shown as "open on desktop"). */
data class UserTaskAttachmentContent(val info: UserTaskAttachmentInfo, val text: String?)

sealed interface UserTaskBoardState {
    data object Idle : UserTaskBoardState
    data object Loading : UserTaskBoardState
    data class Ready(val rows: List<UserTaskRow>, val refreshing: Boolean = false) : UserTaskBoardState
    data class Failed(val message: String, val rows: List<UserTaskRow> = emptyList()) : UserTaskBoardState
}

/**
 * The phone's mirror of the user's task board. The phone IS the user, so
 * every task it adds is authored "you" by the desktop gate, never by argument.
 */
class UserTaskRepository {
    private val _board = MutableStateFlow<UserTaskBoardState>(UserTaskBoardState.Idle)
    val board: StateFlow<UserTaskBoardState> = _board.asStateFlow()

    private val _details = MutableStateFlow<Map<String, UserTaskDetail>>(emptyMap())
    val details: StateFlow<Map<String, UserTaskDetail>> = _details.asStateFlow()

    private val _attachment = MutableStateFlow<UserTaskAttachmentContent?>(null)
    val attachment: StateFlow<UserTaskAttachmentContent?> = _attachment.asStateFlow()

    private val _writeError = MutableStateFlow<String?>(null)
    val writeError: StateFlow<String?> = _writeError.asStateFlow()

    private fun rows(): List<UserTaskRow> = when (val s = _board.value) {
        is UserTaskBoardState.Ready -> s.rows
        is UserTaskBoardState.Failed -> s.rows
        else -> emptyList()
    }

    fun listRequested() {
        val current = rows()
        _board.value = if (current.isEmpty()) UserTaskBoardState.Loading else UserTaskBoardState.Ready(current, refreshing = true)
    }

    fun listArrived(result: Any?): Boolean {
        val array = result as? JSONArray ?: return WireShape.undecodable<Boolean>("a user_task_list result", "a JSON array", result) ?: false
        _board.value = UserTaskBoardState.Ready((0 until array.length()).mapNotNull { parseRow(array.optJSONObject(it)) })
        return true
    }

    fun listFailed(message: String) {
        _board.value = UserTaskBoardState.Failed(message, rows())
    }

    fun detailArrived(result: Any?): Boolean {
        val detail = parseDetail(result as? JSONObject) ?: return false
        _details.value = _details.value + (detail.id to detail)
        return true
    }

    fun attachmentArrived(result: Any?): Boolean {
        val json = result as? JSONObject ?: return false
        val info = parseAttachment(json.optJSONObject("attachment")) ?: return false
        val text = if (json.optString("encoding") == "utf8") json.optString("content") else null
        _attachment.value = UserTaskAttachmentContent(info, text)
        return true
    }

    fun closeAttachment() { _attachment.value = null }

    fun writeFailed(message: String) { _writeError.value = message }
    fun clearWriteError() { _writeError.value = null }

    private fun parseRow(o: JSONObject?): UserTaskRow? {
        val id = o?.opt("id") as? String ?: return null
        return UserTaskRow(
            id = id,
            title = o.optString("title"),
            urgent = o.optBoolean("urgent"),
            projectId = (o.opt("projectId") as? String)?.takeIf { it.isNotEmpty() },
            author = o.optString("author", "you"),
            attachments = o.optInt("attachments"),
            createdAt = o.optLong("createdAt"),
            doneAt = if (o.has("doneAt")) o.optLong("doneAt") else null,
            checklistDone = o.optJSONObject("checklist")?.optInt("done") ?: 0,
            checklistTotal = o.optJSONObject("checklist")?.optInt("total") ?: 0,
            excerpt = o.optString("excerpt"),
        )
    }

    private fun parseAttachment(o: JSONObject?): UserTaskAttachmentInfo? {
        val id = o?.opt("id") as? String ?: return null
        return UserTaskAttachmentInfo(id, o.optString("kind"), o.optString("title"), o.optString("contentType"), o.optLong("sizeBytes"))
    }

    private fun parseDetail(o: JSONObject?): UserTaskDetail? {
        val id = o?.opt("id") as? String ?: return null
        val author = o.optJSONObject("author")
        val ai = author?.optString("kind") == "ai"
        val atts = o.optJSONArray("attachments")
        return UserTaskDetail(
            id = id,
            title = o.optString("title"),
            body = o.optString("body"),
            urgent = o.optBoolean("urgent"),
            projectId = (o.opt("projectId") as? String)?.takeIf { it.isNotEmpty() },
            aiName = if (ai) author?.optString("name") else null,
            aiCli = if (ai) (author?.opt("cliType") as? String) else null,
            aiDir = if (ai) (author?.opt("dir") as? String) else null,
            attachments = atts?.let { a -> (0 until a.length()).mapNotNull { parseAttachment(a.optJSONObject(it)) } }.orEmpty(),
            checklist = o.optJSONArray("checklist")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    val item = a.optJSONObject(i) ?: return@mapNotNull null
                    val itemId = item.opt("id") as? String ?: return@mapNotNull null
                    UserTaskChecklistItem(itemId, item.optString("text"), item.has("doneAt"))
                }
            }.orEmpty(),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            doneAt = if (o.has("doneAt")) o.optLong("doneAt") else null,
        )
    }
}
