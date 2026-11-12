package com.potatomotato.helm.ui

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.save.AndroidArtifactFiles
import com.potatomotato.helm.ui.chat.ChatScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class PhoneChatState(
    val artifactList: ArtifactList,
    val excludedReferenceIds: Map<String, Set<String>>,
    val cachedArtifactsForSession: (String) -> List<HelmArtifact>,
)

internal data class PhoneChatActionContext(
    val client: HelmClient,
    val appContext: Context,
    val scope: CoroutineScope,
    val home: HelmHomeState,
    val requestedLines: Int,
    val dial: (String) -> Unit,
    val artifactFiles: AndroidArtifactFiles,
    val comfyGallerySaved: String,
    val comfyGallerySaveFailed: String,
    val openAttachment: (String, String) -> Unit,
    val launchAttach: (String, (String) -> Unit) -> Unit,
)

internal data class PhoneChatActions(
    val onSend: (String, String) -> Unit,
    val onSendWithProfile: (String, String, String?, String?, String?, List<String>) -> Unit,
    val onRetry: (String, String, String) -> Unit,
    val onUnfreeze: (String, Pair<String, String>?) -> Unit,
    val onDelete: (String, Set<String>) -> Unit,
    val onTerminal: (String) -> Unit,
    val onPull: (String, String, ChatAttachment) -> Unit,
    val onCancelPull: (String) -> Unit,
    val onDeleteAttachment: (String, String, ChatAttachment) -> Unit,
    val onOpenAttachment: (String, String) -> Unit,
    val onComfyReferenceSelection: (String, Set<String>, Set<String>) -> Unit,
    val onDeleteGalleryAttachment: (String, ChatAttachment) -> Unit,
    val onGalleryDownload: (String, ChatAttachment) -> Unit,
    val onGalleryPreview: (String, ChatAttachment) -> Unit,
    val onGallerySavePreview: (String, ChatAttachment, String) -> Unit,
    val onRefreshComfyGallery: (String) -> Unit,
    val onCall: (String) -> Unit,
    val onAttach: (String, (String) -> Unit) -> Unit,
)

internal fun phoneChatActions(input: PhoneChatActionContext) = PhoneChatActions(
    onSend = { sessionId, text -> input.client.sessions.sendChat(sessionId, text) },
    onSendWithProfile = { sessionId, text, profile, imageSize, imagePath, attachmentIds ->
        input.client.sessions.sendChat(sessionId, text, profile, imageSize, imagePath, attachmentIds)
    },
    // Retry re-issues over the wire (the repository swaps the dead row). Delete
    // removes the rows here and tells the desktop which of them it holds, so its
    // journal (and an API session's history) drop them too.
    onRetry = { sessionId, key, text -> input.client.sessions.resendChat(sessionId, key, text) },
    onUnfreeze = { sessionId, retry -> input.client.sessions.unfreeze(sessionId, retry) },
    onDelete = { sessionId, keys -> input.client.sessions.deleteChats(sessionId, keys) },
    onTerminal = { sessionId ->
        input.home.selectedSessionId = sessionId
        input.home.destination = Destination.Snapshot
        input.client.sessions.readTerminal(sessionId, input.requestedLines)
    },
    onPull = { sessionId, key, attachment -> input.client.artifacts.pullChatAttachment(sessionId, key, attachment) },
    onCancelPull = { key -> input.client.sessions.chats.pullCancelled(key) },
    onDeleteAttachment = { sessionId, key, attachment ->
        input.client.artifacts.deleteChatAttachment(sessionId, key, attachment)
    },
    onOpenAttachment = input.openAttachment,
    onComfyReferenceSelection = { sessionId, known, included ->
        input.client.sessions.chats.setComfyReferenceSelection(sessionId, known, included)
    },
    onDeleteGalleryAttachment = { sessionId, attachment ->
        input.client.artifacts.deleteArtifactAttachment(sessionId, attachment.artifactId, attachment.attachmentId) {
            input.client.sessions.chats.removeAttachmentReference(sessionId, attachment.artifactId, attachment.attachmentId)
            input.client.artifacts.refreshArtifacts(sessionId)
        }
    },
    onGalleryDownload = { sessionId, attachment ->
        input.client.artifacts.downloadArtifactAttachment(sessionId, attachment.artifactId, attachment.toHelmArtifactAttachment())
    },
    onGalleryPreview = { sessionId, attachment ->
        input.client.artifacts.previewArtifactAttachment(sessionId, attachment.artifactId, attachment.toHelmArtifactAttachment())
    },
    onGallerySavePreview = { _, attachment, uri ->
        input.scope.launch {
            try {
                val saved = withContext(Dispatchers.IO) {
                    input.appContext.contentResolver.openInputStream(Uri.parse(uri))
                        ?.use { input.artifactFiles.save(attachment.filename, attachment.mimeType, it) }
                        ?: error(CANNOT_WRITE_FILE)
                }
                input.client.artifacts.state.attachmentPulls.pullSaved(
                    artifactAttachmentKey(attachment.artifactId, attachment.attachmentId),
                    saved.location,
                    saved.uri,
                )
                Toast.makeText(input.appContext, input.comfyGallerySaved.format(saved.location), Toast.LENGTH_LONG).show()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Toast.makeText(
                    input.appContext,
                    input.comfyGallerySaveFailed.format(error.message ?: CANNOT_WRITE_FILE),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    },
    onRefreshComfyGallery = { sessionId -> input.client.artifacts.refreshArtifacts(sessionId) },
    onCall = input.dial,
    onAttach = input.launchAttach,
)

/** One chat adapter shared by an open session and the Helm operator panel. */
@Composable
internal fun PhoneChatContent(
    state: PhoneScaffoldState,
    actions: PhoneScaffoldActions,
    sessionId: String,
    onSwipeSession: ((Int) -> Boolean)?,
    earlierUnread: Int,
    laterUnread: Int,
) {
    val artifactsForChat = when (val listed = state.chat.artifactList) {
        is ArtifactList.Ready -> if (listed.sessionId == sessionId) listed.artifacts else state.chat.cachedArtifactsForSession(sessionId)
        is ArtifactList.Refreshing -> if (listed.sessionId == sessionId) listed.cached else state.chat.cachedArtifactsForSession(sessionId)
        else -> state.chat.cachedArtifactsForSession(sessionId)
    }
    val comfyGallery = buildList {
        artifactsForChat.filter { it.title == "Chat files" }.forEach { artifact ->
            artifact.attachments.filter { it.contentType?.startsWith("image/") == true }.forEach { attachment ->
                add(attachment.createdAtEpochMs to ChatAttachment(
                    artifactId = artifact.id,
                    attachmentId = attachment.id,
                    filename = attachment.filename,
                    mimeType = attachment.contentType ?: "image/*",
                    sizeBytes = attachment.sizeBytes,
                    sha256 = attachment.sha256,
                    generatedMedia = attachment.generatedMedia,
                ))
            }
        }
        state.threads[sessionId].orEmpty().forEach { message ->
            message.attachment?.takeIf { it.mimeType.startsWith("image/") }?.let { add(message.at to it) }
        }
    }.distinctBy { it.second.artifactId to it.second.attachmentId }
        .sortedBy { it.first }
        .map { it.second }
    val density = LocalDensity.current
    val home = state.homeState

    ChatScreen(
        sessionId = sessionId,
        onSwipeSession = onSwipeSession,
        onSwipePreview = { step, verticalDeltaPx ->
            if (step == 0) home.updateSwipeTarget(null) else {
                val rowHeightPx = with(density) { 80.dp.toPx() }
                val targetIndex = com.potatomotato.helm.ui.sessions.SessionRows.verticalDragTargetIndex(
                    state.listedSessionIds, sessionId, step, verticalDeltaPx, rowHeightPx,
                )
                home.updateSwipeTarget(targetIndex?.let(state.listedSessionIds::getOrNull))
            }
        },
        swipeOffset = state.sessionSwipeOffset,
        earlierUnreadSessions = earlierUnread,
        laterUnreadSessions = laterUnread,
        messages = state.threads[sessionId].orEmpty(),
        onSend = { text -> actions.chat.onSend(sessionId, text) },
        onSendWithProfile = { text, profile, imageSize, imagePath, attachmentIds ->
            actions.chat.onSendWithProfile(sessionId, text, profile, imageSize, imagePath, attachmentIds)
        },
        onRetry = { key, text -> actions.chat.onRetry(sessionId, key, text) },
        session = state.sessions.firstOrNull { it.id == sessionId },
        onUnfreeze = { retry -> actions.chat.onUnfreeze(sessionId, retry) },
        onDelete = { keys -> actions.chat.onDelete(sessionId, keys) },
        onTerminal = { actions.chat.onTerminal(sessionId) },
        pulls = state.pulls,
        onPull = { key, attachment -> actions.chat.onPull(sessionId, key, attachment) },
        onCancelPull = actions.chat.onCancelPull,
        onDeleteAttachment = { key, attachment -> actions.chat.onDeleteAttachment(sessionId, key, attachment) },
        onOpenAttachment = actions.chat.onOpenAttachment,
        comfyGallery = comfyGallery,
        excludedComfyReferenceIds = state.chat.excludedReferenceIds[sessionId].orEmpty(),
        comfyGalleryPulls = state.artifactPulls,
        onComfyReferenceSelection = { known, included ->
            actions.chat.onComfyReferenceSelection(sessionId, known, included)
        },
        onDeleteGalleryAttachment = { attachment -> actions.chat.onDeleteGalleryAttachment(sessionId, attachment) },
        onGalleryDownload = { attachment -> actions.chat.onGalleryDownload(sessionId, attachment) },
        onGalleryPreview = { attachment -> actions.chat.onGalleryPreview(sessionId, attachment) },
        onGallerySavePreview = { attachment, uri -> actions.chat.onGallerySavePreview(sessionId, attachment, uri) },
        onRefreshComfyGallery = { actions.chat.onRefreshComfyGallery(sessionId) },
        call = state.liveCall?.takeIf { it.targetId == sessionId },
        // One call at a time: while another session is on a call, this one cannot ring.
        onCall = if (state.liveCall == null) ({ actions.chat.onCall(sessionId) }) else null,
        onAttach = { insert -> actions.chat.onAttach(sessionId, insert) },
    )
}

private fun ChatAttachment.toHelmArtifactAttachment() = HelmArtifactAttachment(
    id = attachmentId,
    filename = filename,
    contentType = mimeType,
    sizeBytes = sizeBytes,
    createdAtEpochMs = 0,
    sha256 = sha256,
    generatedMedia = generatedMedia,
)
