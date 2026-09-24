package com.potatomotato.helm.data

import com.potatomotato.helm.log.HelmLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Everything [ChatRepository] needs to come back from a restart — saved as ONE
 * value so the cursor can never describe history that was not saved with it.
 */
data class ChatSnapshot(
    val threads: Map<String, List<ChatMessage>>,
    val lastSeq: Long,
    /** This phone's recent originIds, so a replayed echo of its own words still drops. */
    val sentIds: List<String> = emptyList(),
)

/**
 * Where chat threads live between app launches. An interface for the same
 * reason as [UnreadStore]: the repository's logic is testable without a device.
 */
interface ChatStore {
    /** What was saved last, or null for a cold start (no file, or an unreadable one). */
    fun load(): ChatSnapshot?

    fun save(snapshot: ChatSnapshot)
}

/** The default until the app attaches the file store; also the test fake. */
class MemoryChatStore : ChatStore {
    var saved: ChatSnapshot? = null
        private set

    override fun load(): ChatSnapshot? = saved

    override fun save(snapshot: ChatSnapshot) {
        saved = snapshot
    }
}

/**
 * [ChatStore] as one JSON file in app-private storage, replaced atomically
 * (temp file + move), so a kill mid-write leaves the previous file whole.
 *
 * Writes run on [executor] and coalesce: a journal replay mutates the threads
 * once per record, and only the newest snapshot is worth the disk.
 *
 * A file that will not parse is a cold start — the desktop still holds the
 * journal, so the cost of forgetting is one full replay, never a crash.
 */
class FileChatStore(
    private val file: File,
    private val executor: Executor = Executors.newSingleThreadExecutor(),
) : ChatStore {
    private val lock = Any()
    private var pending: ChatSnapshot? = null

    override fun load(): ChatSnapshot? {
        if (!file.exists()) return null
        return try {
            ChatSnapshotJson.decode(JSONObject(file.readText()))
        } catch (e: Exception) {
            HelmLog.w(HelmLog.CLIENT, "chat store unreadable, starting cold: ${e.message}")
            null
        }
    }

    override fun save(snapshot: ChatSnapshot) {
        val schedule = synchronized(lock) {
            val idle = pending == null
            pending = snapshot
            idle
        }
        if (schedule) executor.execute(::flush)
    }

    private fun flush() {
        val snapshot = synchronized(lock) { pending.also { pending = null } } ?: return
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.writeText(ChatSnapshotJson.encode(snapshot).toString())
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: Exception) {
            HelmLog.w(HelmLog.CLIENT, "chat store write failed: ${e.message}")
        }
    }
}

/** The file format. Row keys are not saved: the repository re-keys on load. */
internal object ChatSnapshotJson {
    private const val VERSION = 1

    fun encode(snapshot: ChatSnapshot): JSONObject = JSONObject().apply {
        put("v", VERSION)
        put("lastSeq", snapshot.lastSeq)
        put("sentIds", JSONArray(snapshot.sentIds))
        put("threads", JSONObject().apply {
            for ((sessionId, thread) in snapshot.threads) {
                put(sessionId, JSONArray().apply { thread.forEach { put(encode(it)) } })
            }
        })
    }

    private fun encode(message: ChatMessage): JSONObject = JSONObject().apply {
        put("text", message.text)
        put("at", message.at)
        put("fromPhone", message.fromPhone)
        message.delivery?.let { put("delivery", it.name) }
        message.filePath?.let { put("filePath", it) }
        if (message.voice) put("voice", true)
        message.seq?.let { put("seq", it) }
        message.attachment?.let {
            put("attachment", JSONObject().apply {
                put("artifactId", it.artifactId)
                put("attachmentId", it.attachmentId)
                put("filename", it.filename)
                put("mimeType", it.mimeType)
                put("sizeBytes", it.sizeBytes)
            })
        }
    }

    /** Throws on anything malformed; the caller turns that into a cold start. */
    fun decode(json: JSONObject): ChatSnapshot {
        require(json.getInt("v") == VERSION) { "unknown chat store version" }
        val threads = json.getJSONObject("threads")
        val sentIds = json.optJSONArray("sentIds")
        return ChatSnapshot(
            threads = threads.keys().asSequence().associateWith { sessionId ->
                val rows = threads.getJSONArray(sessionId)
                (0 until rows.length()).map { decodeRow(rows.getJSONObject(it)) }
            },
            lastSeq = json.getLong("lastSeq"),
            sentIds = if (sentIds == null) emptyList() else (0 until sentIds.length()).map { sentIds.getString(it) },
        )
    }

    private fun decodeRow(row: JSONObject): ChatMessage = ChatMessage(
        key = "",
        text = row.getString("text"),
        at = row.getLong("at"),
        fromPhone = row.getBoolean("fromPhone"),
        delivery = if (row.has("delivery")) Delivery.valueOf(row.getString("delivery")) else null,
        filePath = if (row.has("filePath")) row.getString("filePath") else null,
        voice = row.optBoolean("voice", false),
        attachment = row.optJSONObject("attachment")?.let {
            ChatAttachment(
                artifactId = it.getString("artifactId"),
                attachmentId = it.getString("attachmentId"),
                filename = it.getString("filename"),
                mimeType = it.getString("mimeType"),
                sizeBytes = it.getLong("sizeBytes"),
            )
        },
        seq = if (row.has("seq")) row.getLong("seq") else null,
    )
}
