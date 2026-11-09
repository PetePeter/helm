package com.potatomotato.helm.ui

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.METHOD_SHARE_ADD
import com.potatomotato.helm.data.ShareState
import com.potatomotato.helm.data.StageVerdict
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.shareRefusal
import com.potatomotato.helm.data.stageVerdict
import com.potatomotato.helm.data.uploadSupport
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.save.AndroidAttachmentStaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

internal data class PhoneAttachmentContext(
    val client: HelmClient,
    val appContext: Context,
    val scope: CoroutineScope,
    val home: HelmHomeState,
    val sessions: List<HelmSession>,
    val capabilities: Capabilities,
    val linkState: LinkState,
    val openAttachment: (String, String) -> Unit,
)

internal data class PhoneAttachmentActions(
    val attachSupport: com.potatomotato.helm.data.UploadSupport,
    val chatAttachSession: MutableState<HelmSession?>,
    val shareState: ShareState,
    val openStagedFile: (StagedAttachment) -> Unit,
    val launchCamera: () -> Unit,
    val launchGallery: () -> Unit,
    val launchFiles: () -> Unit,
    val launchReplace: (String) -> Unit,
    val launchChatAttach: (String, (String) -> Unit) -> Unit,
)

@Composable
internal fun rememberPhoneAttachmentActions(input: PhoneAttachmentContext): PhoneAttachmentActions {
    val context = input.appContext
    val client = input.client
    val scope = input.scope
    // Artifact-editor pickers live at the UI edge; staging uses the client's
    // port, and chips stay driven by the client's upload state.
    val staging = remember { AndroidAttachmentStaging(context) }
    var cameraTarget by remember { mutableStateOf<Uri?>(null) }
    val attachNote: (Int) -> Unit = { res ->
        Toast.makeText(context, context.getString(res), Toast.LENGTH_LONG).show()
    }
    // A pick becomes a chip only if it can be READ (here, now — a revoked grant
    // must not become a chip that fails later) and is within the size the
    // desktop would accept. Both refusals are toasts: they are about one tap,
    // not about the editor.
    val stagePick: (Uri) -> Unit = { uri ->
        scope.launch {
            val picked = staging.stage(uri.toString(), displayName = null, mimeType = null)
            when {
                picked == null -> attachNote(R.string.artifacts_attach_refused)
                stageVerdict(picked.sizeBytes) is StageVerdict.TooLarge -> {
                    staging.discard(picked)
                    attachNote(R.string.artifacts_attach_too_large)
                }
                else -> client.artifacts.uploads.stage(picked)
            }
        }
        Unit
    }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val target = cameraTarget
        cameraTarget = null
        if (captured && target != null) stagePick(target)
    }
    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) stagePick(uri)
    }
    val filesLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) stagePick(uri)
    }
    // Which existing attachment the open file picker is replacing. Saveable so
    // the answer still finds its target if the picker outlived a rotation.
    var replacingAttachmentId by rememberSaveable { mutableStateOf<String?>(null) }
    // Replace uses the same read-now + size guard as a plain pick; only the
    // hand-off differs — the client uploads first and deletes the old file only
    // after the new one's commit, so a failure never loses the original.
    val replaceLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val oldId = replacingAttachmentId
        replacingAttachmentId = null
        val sessionId = input.home.selectedSessionId
        val artifactId = input.home.editingArtifactId
        if (uri != null && oldId != null && sessionId != null && artifactId != null) {
            scope.launch {
                val picked = staging.stage(uri.toString(), displayName = null, mimeType = null)
                when {
                    picked == null -> attachNote(R.string.artifacts_attach_refused)
                    stageVerdict(picked.sizeBytes) is StageVerdict.TooLarge -> {
                        staging.discard(picked)
                        attachNote(R.string.artifacts_attach_too_large)
                    }
                    else -> client.artifacts.replaceArtifactAttachment(sessionId, artifactId, oldId, picked)
                }
            }
        }
    }
    // Open the local copy through the provider: the picker's uri may be long dead by tap time.
    val openStagedFile: (StagedAttachment) -> Unit = { staged ->
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", File(staged.localPath))
        input.openAttachment(uri.toString(), staged.mimeType ?: DEFAULT_OPEN_MIME)
    }
    // Read both toolbar gates live so revoking either negotiated protocol or
    // permitted desktop tool greys the controls on the next recomposition.
    val attachSupport = uploadSupport(
        toolPermitted = when (val caps = input.capabilities) {
            is Capabilities.Known -> METHOD_ATTACHMENT_ADD in caps.tools
            else -> null
        },
        negotiatedProtocol = client.artifacts.negotiatedProtocol(),
        linked = input.linkState == LinkState.Linked,
    )

    // Chat attachment uses the same share-to-Helm upload, committed without a
    // draft; the returned desktop path is inserted into the composer.
    var chatInsert by remember { mutableStateOf<((String) -> Unit)?>(null) }
    val chatAttachSession = remember { mutableStateOf<HelmSession?>(null) }
    val shareState by client.artifacts.shares.state.collectAsState()
    val chatAttachLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val insert = chatInsert
        val session = chatAttachSession.value
        chatInsert = null
        if (uri == null || insert == null || session == null) {
            chatAttachSession.value = null
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            val staged = staging.stage(uri.toString(), displayName = null, mimeType = null)
            if (staged == null) {
                chatAttachSession.value = null
                attachNote(R.string.artifacts_attach_refused)
                return@launch
            }
            val support = uploadSupport(
                toolPermitted = when (val caps = input.capabilities) {
                    is Capabilities.Known -> METHOD_SHARE_ADD in caps.tools
                    else -> null
                },
                negotiatedProtocol = client.artifacts.negotiatedProtocol(),
                linked = input.linkState == LinkState.Linked,
            )
            val refusal = shareRefusal(staged.sizeBytes, HelmLink.holderRank, support)
            if (refusal != null) {
                chatAttachSession.value = null
                Toast.makeText(context, refusal, Toast.LENGTH_LONG).show()
                return@launch
            }
            Toast.makeText(context, context.getString(R.string.chat_attach_sending, staged.filename), Toast.LENGTH_SHORT).show()
            client.artifacts.shareFile(session.id, session.name, staged) { path ->
                // The answer lands on the link's thread; the draft is main-thread state.
                scope.launch(Dispatchers.Main) {
                    chatAttachSession.value = null
                    insert(path)
                }
            }
        }
    }
    val launchChatAttach: (String, (String) -> Unit) -> Unit = { sessionId, insert ->
        chatInsert = insert
        val targetSession = input.sessions.firstOrNull { it.id == sessionId }
        chatAttachSession.value = targetSession
        chatAttachLauncher.launch(if (targetSession?.comfyUiTool == true) "image/*" else "*/*")
    }

    return PhoneAttachmentActions(
        attachSupport = attachSupport,
        chatAttachSession = chatAttachSession,
        shareState = shareState,
        openStagedFile = openStagedFile,
        launchCamera = {
            val dir = File(context.cacheDir, CAMERA_DIRECTORY).apply { mkdirs() }
            val file = File(dir, "capture-${System.nanoTime()}.jpg")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            cameraTarget = uri
            cameraLauncher.launch(uri)
        },
        launchGallery = {
            galleryLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        launchFiles = { filesLauncher.launch(ANY_MIME) },
        launchReplace = { attachmentId ->
            replacingAttachmentId = attachmentId
            replaceLauncher.launch(ANY_MIME)
        },
        launchChatAttach = launchChatAttach,
    )
}

private const val DEFAULT_OPEN_MIME = "application/octet-stream"
private const val CAMERA_DIRECTORY = "artifact-capture"
private const val ANY_MIME = "*/*"
private const val METHOD_ATTACHMENT_ADD = "session_artifact_attachment_add"
