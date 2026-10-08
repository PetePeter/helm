package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.ui.call.CallPanel
import com.potatomotato.helm.data.CacheStage
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.ComfyUiProfile
import com.potatomotato.helm.data.ComfyUiImageSize
import com.potatomotato.helm.voice.CallPhase
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.ui.sessions.SessionRows
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.activity.compose.BackHandler
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.Draft
import com.potatomotato.helm.data.PrefsDraftStore
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.data.rangeSelection
import com.potatomotato.helm.data.replyStats
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LinkedText
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

/**
 * Mockup screen 2 — one session's conversation, and the reply box.
 *
 * This is the forum topic done properly: the thread is the session and the reply
 * goes to the session's PTY. It is the session's Chat TAB — the bar above it
 * (with the link state, so a message typed into a dead link is never mistaken
 * for one that was delivered) belongs to the scaffold that hosts the tabs.
 */
@Composable
fun ChatScreen(
    sessionId: String,
    messages: List<ChatMessage>,
    onSend: (String) -> Unit,
    onSendWithProfile: ((String, String?, String?, String?, List<String>) -> Unit)? = null,
    onRetry: (key: String, text: String) -> Unit,
    /** Delete rows by key: one (a failed send's cross) or a whole selection. */
    onDelete: (keys: Set<String>) -> Unit,
    onTerminal: () -> Unit,
    modifier: Modifier = Modifier,
    /** Per-message attachment fetch state, keyed like the thread. */
    pulls: Map<String, PullState> = emptyMap(),
    onPull: (key: String, attachment: ChatAttachment) -> Unit = { _, _ -> },
    onCancelPull: (key: String) -> Unit = {},
    onDeleteAttachment: (key: String, attachment: ChatAttachment) -> Unit = { _, _ -> },
    onOpenAttachment: (uri: String, mimeType: String) -> Unit = { _, _ -> },
    /** The live call with THIS session, or null. While live it replaces the composer. */
    call: VoiceCallService.Call? = null,
    /** Dial this session. Null hides the call button (a call elsewhere is live). */
    onCall: (() -> Unit)? = null,
    /**
     * Pick and upload a file; the host calls `insert` with its desktop path once
     * it lands, and the path joins the draft to be sent with the message.
     */
    onAttach: ((insert: (path: String) -> Unit) -> Unit)? = null,
    /** The session, for its freeze / prompt-cache banner. Null hides the banner. */
    session: HelmSession? = null,
    /** Thaw the session; with a bubble's key + text, resend it after. */
    onUnfreeze: (retry: Pair<String, String>?) -> Unit = {},
    /** Switch to the neighboring session after a swipe crosses half the chat width. */
    onSwipeSession: ((step: Int) -> Boolean)? = null,
    onSwipePreview: ((step: Int, verticalDeltaPx: Float) -> Unit)? = null,
    swipeOffset: Animatable<Float, AnimationVector1D>,
    earlierUnreadSessions: Int = 0,
    laterUnreadSessions: Int = 0,
    comfyGallery: List<ChatAttachment> = emptyList(),
    excludedComfyReferenceIds: Set<String> = emptySet(),
    comfyGalleryPulls: Map<String, PullState> = emptyMap(),
    onComfyReferenceSelection: (knownIds: Set<String>, includedIds: Set<String>) -> Unit = { _, _ -> },
    onGalleryDownload: (ChatAttachment) -> Unit = {},
    onRefreshComfyGallery: () -> Unit = {},
) {
    // Keyed on the session, and saveable: a half-typed reply survives a rotation
    // but must NEVER follow the user into a different session's thread. It also
    // survives leaving the thread and the process itself — every edit lands in
    // [drafts], so coming back to a chat finds the words (and the caret) where
    // they were left. The value carries its selection because dictation lands
    // AT THE CARET, so the caret has to be something the composer knows rather
    // than something the text field keeps to itself.
    val context = LocalContext.current
    val drafts = remember { PrefsDraftStore(context) }
    var draft by rememberSaveable(sessionId, stateSaver = TextFieldValue.Saver) {
        mutableStateOf(
            drafts.load(sessionId)?.let { TextFieldValue(it.text, TextRange(it.caret)) } ?: TextFieldValue(),
        )
    }
    val listState = rememberLazyListState()
    val currentSwipeSession by rememberUpdatedState(onSwipeSession)
    val currentSwipePreview by rememberUpdatedState(onSwipePreview)
    var swipeWidthPx by remember(sessionId) { mutableIntStateOf(0) }
    val swipeScope = rememberCoroutineScope()
    val threadSwipeModifier = if (onSwipeSession == null) {
        Modifier
    } else {
        Modifier.onSizeChanged { swipeWidthPx = it.width }
            .pointerInput(sessionId, swipeWidthPx) {
            var horizontalDrag = 0f
            var startY = 0f
            detectHorizontalDragGestures(
                onDragStart = { start ->
                    horizontalDrag = 0f
                    startY = start.y
                    currentSwipePreview?.invoke(0, 0f)
                    swipeScope.launch { swipeOffset.snapTo(0f) }
                },
                onDragEnd = {
                    val threshold = if (swipeWidthPx > 0) SessionRows.swipeThreshold(swipeWidthPx) else 0f
                    val step = if (threshold > 0f) SessionRows.swipeStep(horizontalDrag, threshold) else 0
                    val changed = step != 0 && currentSwipeSession?.invoke(step) == true
                    if (step == 0) {
                        swipeScope.launch {
                            swipeOffset.animateTo(0f, animationSpec = spring(dampingRatio = 0.62f, stiffness = 720f))
                        }
                    } else {
                        swipeScope.launch {
                            swipeOffset.animateTo(
                                targetValue = 0f,
                                animationSpec = if (changed) tween(SESSION_SWITCH_MS) else spring(dampingRatio = 0.62f, stiffness = 720f),
                            )
                        }
                    }
                },
                onDragCancel = {
                    horizontalDrag = 0f
                    currentSwipePreview?.invoke(0, 0f)
                    swipeScope.launch {
                        swipeOffset.animateTo(0f, animationSpec = spring(dampingRatio = 0.62f, stiffness = 720f))
                    }
                },
                onHorizontalDrag = { change, dragAmount ->
                    if (swipeWidthPx > 0) {
                        horizontalDrag = (horizontalDrag + dragAmount).coerceIn(-swipeWidthPx.toFloat(), swipeWidthPx.toFloat())
                        swipeScope.launch { swipeOffset.snapTo(horizontalDrag) }
                        val threshold = SessionRows.swipeThreshold(swipeWidthPx)
                        if (threshold > 0f) {
                            val step = SessionRows.swipeStep(horizontalDrag, threshold)
                            val previewStep = when {
                                step != 0 -> step
                                horizontalDrag > 8f -> -1
                                horizontalDrag < -8f -> 1
                                else -> 0
                            }
                            currentSwipePreview?.invoke(previewStep, change.position.y - startY)
                        }
                    }
                },
            )
        }
    }
    var comfyProfileId by rememberSaveable(sessionId) {
        mutableStateOf(session?.comfyUiProfiles?.firstOrNull()?.id.orEmpty())
    }
    LaunchedEffect(sessionId, session?.comfyUiProfiles) {
        if (session?.comfyUiProfiles?.none { it.id == comfyProfileId } == true) {
            comfyProfileId = session.comfyUiProfiles.firstOrNull()?.id.orEmpty()
        }
    }
    var comfyImageSizeId by rememberSaveable(sessionId) {
        mutableStateOf(session?.comfyUiImageSizes?.firstOrNull()?.id.orEmpty())
    }
    LaunchedEffect(sessionId, session?.comfyUiImageSizes) {
        if (session?.comfyUiImageSizes?.none { it.id == comfyImageSizeId } == true) {
            comfyImageSizeId = session.comfyUiImageSizes.firstOrNull()?.id.orEmpty()
        }
    }
    var comfyInputImagePath by rememberSaveable(sessionId) { mutableStateOf<String?>(null) }
    val selectedComfyProfile = session?.comfyUiProfiles?.firstOrNull { it.id == comfyProfileId }
    val comfyMaxReferences = selectedComfyProfile?.maxReferenceImages?.coerceIn(1, 16) ?: 1
    val comfyMaxGalleryReferences = (comfyMaxReferences - if (comfyInputImagePath != null) 1 else 0).coerceAtLeast(0)
    val knownGalleryIds = comfyGallery.map { it.attachmentId }.toSet()
    val includedGalleryIds = knownGalleryIds - excludedComfyReferenceIds
    LaunchedEffect(sessionId, session?.comfyUiTool) {
        if (session?.comfyUiTool == true) onRefreshComfyGallery()
    }
    LaunchedEffect(knownGalleryIds, includedGalleryIds, comfyMaxGalleryReferences) {
        if (includedGalleryIds.size > comfyMaxGalleryReferences) {
            val latestAllowed = comfyGallery.asSequence().map { it.attachmentId }
                .filter { it in includedGalleryIds }.toList().takeLast(comfyMaxGalleryReferences).toSet()
            onComfyReferenceSelection(knownGalleryIds, latestAllowed)
        }
    }

    // Selection mode: long-press a bubble to start, tap to toggle. Keyed on the
    // session like the draft: a selection never follows the user into another
    // thread. Rows that vanish (deleted elsewhere, capped out) drop out of it.
    var selectedKeys by rememberSaveable(sessionId) { mutableStateOf(listOf<String>()) }
    val liveKeys = messages.map { it.key }
    val selected = selectedKeys.filter { it in liveKeys }.toSet()
    val selecting = selected.isNotEmpty()
    fun toggle(key: String) {
        selectedKeys = if (key in selected) (selected - key).toList() else (selected + key).toList()
    }
    val clipboard = LocalClipboardManager.current
    BackHandler(enabled = selecting) { selectedKeys = emptyList() }

    // Every entry into a thread starts at the newest bubble. Seeding the list
    // state is not enough: history often lands AFTER first composition (empty →
    // filled), by which time the initial index is already captured at 0. So the
    // anchor fires on the first non-empty frame of each session instead. The
    // flag is saveable and keyed like the draft: a rotation restores it as true
    // (position keeps), while a session switch re-keys it to false (re-anchor).
    var anchored by rememberSaveable(sessionId) { mutableStateOf(false) }
    LaunchedEffect(sessionId, messages.isEmpty()) {
        if (!anchored && messages.isNotEmpty()) {
            listState.scrollToItem(messages.lastIndex)
            anchored = true
        }
    }

    // Follow the conversation, but only from the bottom. A user who has scrolled
    // up is READING; yanking them back to the newest line on every arriving
    // message — or on a reconnect that delivers a backlog — loses their place,
    // which is exactly what a link drop must not do. The check reads the layout
    // as it is when the message lands, never a value captured earlier.
    LaunchedEffect(messages.size) {
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        val wasAtBottom = lastVisible < 0 || lastVisible >= messages.size - 2
        if (messages.isNotEmpty() && wasAtBottom) listState.scrollToItem(messages.lastIndex)
    }

    // The keyboard opening shrinks the thread from the bottom, which on its own
    // leaves the newest lines hidden behind where the composer just was. Reading
    // (not consuming) the IME inset is allowed — insets stay owned by HelmTheme;
    // see InsetsOwnedByThemeTest for the line between the two.
    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(imeBottom) {
        if (imeBottom > 0 && messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex)
    }

    // No app bar here: the session's chrome (title, link badge, back, overflow,
    // tab row) is owned by the session scaffold, so it does not flicker or
    // re-lay-out when the user moves between a session's tabs.
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        session?.let { CacheBanner(it, onUnfreeze = { onUnfreeze(null) }) }
        if (selecting) {
            SelectionBar(
                count = selected.size,
                onCopy = {
                    // Thread order, not tap order: a copied exchange reads as it happened.
                    val text = messages.filter { it.key in selected }.joinToString("\n\n") { it.text }
                    clipboard.setText(AnnotatedString(text))
                    selectedKeys = emptyList()
                },
                onRange = { selectedKeys = rangeSelection(liveKeys, selected).toList() },
                onDelete = {
                    onDelete(selected)
                    selectedKeys = emptyList()
                },
                onCancel = { selectedKeys = emptyList() },
            )
            Hairline()
        }
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            Row(modifier = Modifier.fillMaxSize().then(threadSwipeModifier)) {
                Column(modifier = Modifier.weight(1f).fillMaxSize()) {
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        if (messages.isEmpty()) {
                            Box(
                                modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = stringResource(R.string.chat_empty),
                                    color = HelmColors.Dim,
                                    style = MaterialTheme.typography.bodyLarge,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        } else {
                            LazyColumn(
                                state = listState,
                                modifier = Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(HelmSpacing.Gutter),
                                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                            ) {
                                items(messages, key = { it.key }) {
                                    Bubble(
                                        message = it,
                                        comfyUi = session?.comfyUiTool == true,
                                        selected = it.key in selected,
                                        onTap = if (selecting) ({ toggle(it.key) }) else null,
                                        onLongPress = { toggle(it.key) },
                                        onRetry = onRetry,
                                        onUnfreeze = onUnfreeze,
                                        onDelete = onDelete,
                                        pulls = pulls,
                                        onPull = onPull,
                                        onCancelPull = onCancelPull,
                                        onDeleteAttachment = onDeleteAttachment,
                                        onOpenAttachment = onOpenAttachment,
                                    )
                                }
                            }
                        }
                        if (earlierUnreadSessions > 0 || laterUnreadSessions > 0) {
                            SessionSwipeCueHint(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
                            )
                        }
                    }
                    if (call != null && call.state.phase != CallPhase.Ended) {
                        CallPanel(call = call)
                    }
                }
            }
        }

        if (call == null || call.state.phase == CallPhase.Ended) {
          if (session?.comfyUiTool == true && session.comfyUiProfiles.isNotEmpty()) {
              ComfyProfilePicker(
                  profiles = session.comfyUiProfiles,
                  selectedId = comfyProfileId,
                  onSelect = { comfyProfileId = it },
                  imageSizes = session.comfyUiImageSizes,
                  selectedImageSizeId = comfyImageSizeId,
                  onSelectImageSize = { comfyImageSizeId = it },
                  showImageSize = selectedComfyProfile?.supportsImageSize == true,
                  onCancel = {
                      onSendWithProfile?.invoke("/cancel", comfyProfileId, null, null, emptyList()) ?: onSend("/cancel")
                  },
              )
          }
          if (session?.comfyUiTool == true && comfyGallery.isNotEmpty()) {
              ComfyGalleryStrip(
                  items = comfyGallery,
                  includedIds = includedGalleryIds,
                  maxReferences = comfyMaxGalleryReferences,
                  pulls = comfyGalleryPulls,
                  onToggle = { attachment, included ->
                      val next = if (!included) includedGalleryIds - attachment.attachmentId
                      else if (includedGalleryIds.size < comfyMaxGalleryReferences) includedGalleryIds + attachment.attachmentId
                      else includedGalleryIds
                      onComfyReferenceSelection(knownGalleryIds, next)
                  },
                  onDownload = onGalleryDownload,
                  onOpen = onOpenAttachment,
              )
          }
          if (session?.comfyUiTool == true) {
              comfyInputImagePath?.let { path ->
                  Row(
                      modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
                      verticalAlignment = Alignment.CenterVertically,
                  ) {
                      Text("🖼 ${inputImageName(path)}", color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                      Text("✕", color = HelmColors.Dim, style = MaterialTheme.typography.labelLarge, modifier = Modifier.clickable { comfyInputImagePath = null }.padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs))
                  }
              }
          }
          Composer(
            draft = draft,
            onDraft = { next ->
                draft = next
                // Persist as the user types: a draft only earns its keep if the
                // app dying mid-sentence costs nothing. Saving an empty draft
                // is the store's cue to clear (see DraftStore).
                drafts.save(sessionId, Draft(next.text, next.selection.min))
            },
            onTerminal = onTerminal,
            onCall = onCall,
            onAttach = onAttach?.let { attach ->
                {
                    attach { path ->
                        if (session?.comfyUiTool == true) {
                            comfyInputImagePath = path
                        } else {
                            val lead = draft.text.trimEnd().let { if (it.isEmpty()) it else "$it " }
                            val text = "$lead[file] $path "
                            draft = TextFieldValue(text, TextRange(text.length))
                            drafts.save(sessionId, Draft(text, text.length))
                        }
                    }
                }
            },
            onSend = { submitted ->
                val text = submitted.trim()
                val selectedIds = comfyGallery.asSequence().map { it.attachmentId }
                    .filter { it in includedGalleryIds }.toList().takeLast(comfyMaxGalleryReferences)
                val hasComfyInput = comfyInputImagePath != null || selectedIds.isNotEmpty()
                if (text.isNotEmpty() || (session?.comfyUiTool == true && hasComfyInput)) {
                    if (session?.comfyUiTool == true && onSendWithProfile != null) {
                        onSendWithProfile(
                            text, comfyProfileId,
                            comfyImageSizeId.takeIf { selectedComfyProfile?.supportsImageSize == true },
                            comfyInputImagePath,
                            selectedIds,
                        )
                    } else onSend(text)
                    draft = TextFieldValue()
                    comfyInputImagePath = null
                    drafts.clear(sessionId)
                }
            },
            allowEmpty = session?.comfyUiTool == true &&
                (comfyInputImagePath != null || includedGalleryIds.isNotEmpty()),
          )
        }
    }
}

@Composable
private fun ComfyProfilePicker(
    profiles: List<ComfyUiProfile>,
    selectedId: String,
    onSelect: (String) -> Unit,
    imageSizes: List<ComfyUiImageSize>,
    selectedImageSizeId: String,
    onSelectImageSize: (String) -> Unit,
    showImageSize: Boolean,
    onCancel: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var sizeExpanded by remember { mutableStateOf(false) }
    val selected = profiles.firstOrNull { it.id == selectedId } ?: profiles.first()
    val selectedSize = imageSizes.firstOrNull { it.id == selectedImageSizeId } ?: imageSizes.firstOrNull()
    Column(
        modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (selected.kind == "video") "Workflow" else "Model", color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
            Box {
                Text(
                    text = "${selected.name} ▾",
                    color = HelmColors.Accent,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.clickable { expanded = true }.padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
                )
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    profiles.forEach { profile ->
                        DropdownMenuItem(
                            text = { Text(profile.name) },
                            onClick = { onSelect(profile.id); expanded = false },
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                text = "Cancel generation",
                color = HelmColors.Danger,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.clickable(onClick = onCancel).padding(HelmSpacing.Xs),
            )
        }
        if (showImageSize && selectedSize != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Size", color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
                Box {
                    Text(
                        text = "${selectedSize.name} ▾",
                        color = HelmColors.Accent,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clickable { sizeExpanded = true }.padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
                    )
                    DropdownMenu(expanded = sizeExpanded, onDismissRequest = { sizeExpanded = false }) {
                        imageSizes.forEach { size ->
                            DropdownMenuItem(
                                text = { Text("${size.name} (${size.width}×${size.height})") },
                                onClick = { onSelectImageSize(size.id); sizeExpanded = false },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionSwipeCueHint(modifier: Modifier = Modifier) {
    val label = stringResource(R.string.session_swipe_hint)
    Text(
        text = label,
        color = HelmColors.Txt,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier
            .then(modifier)
            .clip(RoundedCornerShape(16.dp))
            .background(HelmColors.Surface2)
            .semantics { contentDescription = label }
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    )
}

/**
 * Sits above the thread while rows are selected: how many, and what can be
 * done to them. Copy lives here rather than on a per-bubble text selection
 * because long-press now means "select this message"; a selection of one
 * copies exactly what the old gesture did.
 */
@Composable
private fun SelectionBar(
    count: Int,
    onCopy: () -> Unit,
    onRange: () -> Unit,
    onDelete: () -> Unit,
    onCancel: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = stringResource(R.string.chat_selected, count),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.weight(1f),
        )
        BubbleAction(R.string.chat_copy_glyph, R.string.chat_copy, HelmColors.Dim, onCopy)
        BubbleAction(R.string.chat_range_glyph, R.string.chat_range, HelmColors.Dim, onRange)
        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete_selected, HelmColors.Danger, onDelete)
        BubbleAction(R.string.chat_cancel_glyph, R.string.chat_cancel_selection, HelmColors.Dim, onCancel)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bubble(
    message: ChatMessage,
    comfyUi: Boolean,
    selected: Boolean,
    /** Non-null while selecting: a tap toggles this row. */
    onTap: (() -> Unit)?,
    onLongPress: () -> Unit,
    onRetry: (key: String, text: String) -> Unit,
    onUnfreeze: (retry: Pair<String, String>?) -> Unit,
    onDelete: (keys: Set<String>) -> Unit,
    pulls: Map<String, PullState>,
    onPull: (key: String, attachment: ChatAttachment) -> Unit,
    onCancelPull: (key: String) -> Unit,
    onDeleteAttachment: (key: String, attachment: ChatAttachment) -> Unit,
    onOpenAttachment: (uri: String, mimeType: String) -> Unit,
) {
    val fromPhone = message.fromPhone

    // The mockup's asymmetric tail: the corner nearest the speaker is pulled in
    // (5dp vs the 16dp rest), which is what says who the bubble grew out of.
    val shape = RoundedCornerShape(
        topStart = HelmRadius.Lg,
        topEnd = HelmRadius.Lg,
        bottomStart = if (fromPhone) HelmRadius.Lg else BUBBLE_TAIL,
        bottomEnd = if (fromPhone) BUBBLE_TAIL else HelmRadius.Lg,
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .then(if (selected) Modifier.background(HelmColors.Accent.copy(alpha = SELECTED_TINT)) else Modifier)
            .combinedClickable(
                onClick = { onTap?.invoke() },
                onLongClick = onLongPress,
            ),
        horizontalArrangement = if (fromPhone) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (fromPhone) Alignment.End else Alignment.Start,
            // Three quarters of the thread's width, not a fixed dp: the bubble
            // should read the same on a small phone and a tablet, and the
            // quarter left over is what keeps the other speaker's side visible.
            // The column is the ceiling; the bubble inside it still hugs its own
            // text and sits on its speaker's edge.
            modifier = Modifier.fillMaxWidth(BUBBLE_WIDTH_FRACTION),
        ) {
            Box(
                modifier = Modifier
                    .clip(shape)
                    .background(if (fromPhone) HelmColors.Accent else HelmColors.Surface2)
                    .then(
                        // Only the AI bubble carries a hairline — the accent fill
                        // is its own edge against true black.
                        if (fromPhone) Modifier else Modifier.border(HelmSize.Hairline, HelmColors.Line, shape),
                    )
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            ) {
                Column {
                    // Long-press selects the MESSAGE (copy and delete live on the
                    // selection bar), so the text is no longer a text selection of
                    // its own: the two gestures would fight over one press.
                    run {
                        // Linked, not markdown: a chat message is prose, and the
                        // one thing in it worth a tap is a URL. LinkedText keeps
                        // every other marker literal.
                        LinkedText(
                            text = message.text.ifEmpty { stringResource(R.string.chat_attachment) },
                            color = if (fromPhone) HelmColors.OnAccent else HelmColors.Txt,
                            // Accent on the accent bubble is invisible; the underline carries it.
                            linkColor = if (fromPhone) HelmColors.OnAccent else HelmColors.Accent,
                            style = MaterialTheme.typography.bodyMedium.copy(
                                // The mockup sets the me-bubble one weight heavier:
                                // OnAccent on Accent needs it to hold up.
                                fontWeight = if (fromPhone) FontWeight.Medium else null,
                            ),
                        )
                    }
                    message.comfyInputImagePath?.let { path ->
                        Text(
                            text = "🖼 ${inputImageName(path)}",
                            color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.72f) else HelmColors.Dim,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(top = HelmSpacing.Xs),
                        )
                    }
                    message.attachment?.takeUnless { comfyUi && it.mimeType.startsWith("image/") }?.let { attachment ->
                        AttachmentTile(
                            attachment = attachment,
                            state = pulls[message.key] ?: PullState.Idle,
                            onPull = { onPull(message.key, attachment) },
                            onCancel = { onCancelPull(message.key) },
                            onDelete = { onDeleteAttachment(message.key, attachment) },
                            onOpen = onOpenAttachment,
                        )
                    }
                    // Replies carry how full the session's context is; API tools add tool calls.
                    replyStats(message.contextTokens, message.toolCalls, message.contextWindow, message.thoughtCount)?.let { stats ->
                        Text(
                            text = stats,
                            color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.55f) else HelmColors.Faint,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(top = HelmSpacing.Xs),
                        )
                    }
                    Text(
                        text = formatBubbleTime(message.at),
                        color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.55f) else HelmColors.Faint,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                    )
                }
            }

            // Only outgoing messages carry a delivery state. Sending/Failed tell
            // the user something they cannot otherwise see; Sent is the honest
            // ceiling — the wire has no read receipt, so "✓ Sent" means the
            // session_send_text call was accepted and the text reached the
            // session. A true read ack would land as a new Delivery state here
            // once Helm reports one, not as a guess at one.
            when (message.delivery) {
                Delivery.Sending -> BubbleNote(R.string.chat_sending, HelmColors.Faint)
                Delivery.Sent -> BubbleNote(R.string.chat_sent, HelmColors.Dim)
                Delivery.Frozen -> {
                    BubbleNote(R.string.chat_frozen, HelmColors.Frozen)
                    Row(
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                    ) {
                        BubbleAction(R.string.chat_unfreeze_glyph, R.string.chat_unfreeze_send, HelmColors.Frozen) {
                            onUnfreeze(message.key to message.text)
                        }
                        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete, HelmColors.Dim) {
                            onDelete(setOf(message.key))
                        }
                    }
                }
                Delivery.Failed -> {
                    BubbleNote(R.string.chat_failed, HelmColors.Danger)
                    // A dead attempt gets one row of honest exits: send the same
                    // text again, or take the row away. Delivered messages get no
                    // delete — the desktop already holds a copy no tap here can
                    // reach, so removing the bubble would only be a lie.
                    Row(
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                    ) {
                        BubbleAction(R.string.chat_retry_glyph, R.string.chat_retry, HelmColors.Danger) {
                            onRetry(message.key, message.text)
                        }
                        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete, HelmColors.Dim) {
                            onDelete(setOf(message.key))
                        }
                    }
                }
                null -> Unit
            }
        }
    }
}

/**
 * The file a message is carrying, and the one tap that fetches it.
 *
 * TAP TO PULL, never automatic. The bytes cross the same BLE or LAN link the
 * conversation uses, and a thread full of photos fetching themselves would hold
 * that link for minutes at a time on a radio that manages a few KB a second.
 * The name and size are on the wire, so the user decides with the facts in front
 * of them rather than after the fact.
 *
 * Every state offers a way onward: a stumble retries (resuming, not restarting),
 * a fetch in flight can be abandoned, and a file that is no longer wanted is
 * deleted on the DESKTOP — the tile going away on its own would leave the file
 * sitting in the session's artifacts where the user cannot see it.
 */
@Composable
private fun AttachmentTile(
    attachment: ChatAttachment,
    state: PullState,
    onPull: () -> Unit,
    onCancel: () -> Unit,
    onDelete: () -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    Column(
        modifier = Modifier
            .padding(top = HelmSpacing.Sm)
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Surface)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
            .padding(HelmSpacing.Sm),
    ) {
        // An image that has landed shows itself. A file the user asked for and
        // then has to go hunting for in Downloads is only half delivered.
        if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
            AttachmentPreview(state.uri, attachment.filename)
        } else if (state is PullState.Ready && attachment.mimeType.startsWith("video/")) {
            AttachmentVideoPreview(state.uri)
        }
        Text(
            text = attachment.filename,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(
            text = when (state) {
                is PullState.Idle -> formatBytes(attachment.sizeBytes)
                is PullState.Pulling -> stringResource(
                    R.string.chat_attachment_pulling,
                    formatBytes(state.received),
                    formatBytes(state.total),
                )
                is PullState.Ready -> state.location
                is PullState.Failed -> state.message
            },
            color = if (state is PullState.Failed) HelmColors.Danger else HelmColors.Dim,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(top = HelmSpacing.Xs),
        )
        Row(
            modifier = Modifier.padding(top = HelmSpacing.Xs),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            when (state) {
                is PullState.Idle ->
                    BubbleAction(R.string.chat_attachment_glyph, R.string.chat_attachment_get, HelmColors.Accent, onPull)
                is PullState.Pulling ->
                    BubbleAction(R.string.chat_delete_glyph, R.string.chat_attachment_cancel, HelmColors.Dim, onCancel)
                is PullState.Ready ->
                    BubbleAction(R.string.chat_attachment_open_glyph, R.string.chat_attachment_open, HelmColors.Accent) {
                        onOpen(state.uri, attachment.mimeType)
                    }
                is PullState.Failed ->
                    BubbleAction(R.string.chat_retry_glyph, R.string.chat_attachment_get, HelmColors.Danger, onPull)
            }
            if (state !is PullState.Pulling) {
                BubbleAction(R.string.chat_delete_glyph, R.string.chat_attachment_delete, HelmColors.Dim, onDelete)
            }
        }
    }
}

@Composable
private fun AttachmentVideoPreview(uri: String) {
    val context = LocalContext.current
    val videoView = remember(uri) { VideoView(context) }
    DisposableEffect(videoView) {
        onDispose { videoView.stopPlayback() }
    }
    AndroidView(
        factory = {
            videoView.apply {
                setMediaController(MediaController(context).also { it.setAnchorView(this) })
                setVideoURI(Uri.parse(uri))
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 180.dp, max = 300.dp)
            .clip(RoundedCornerShape(HelmRadius.Sm)),
    )
}

/**
 * The image itself, once it is on the phone.
 *
 * Decoded OFF the main thread and downsampled to a thumbnail: a 12MP photo
 * decoded whole is ~48MB of bitmap, which is how a chat thread runs a phone out
 * of memory. A decode that fails draws nothing — the tile beneath still names
 * the file and still opens it, so a preview is a bonus, never the only route.
 */
@Composable
private fun AttachmentPreview(
    uri: String,
    filename: String,
    maxPx: Int = PREVIEW_MAX_PX,
    fullScreen: Boolean = false,
) {
    val context = LocalContext.current
    var preview by remember(uri) { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(uri) {
        preview = withContext(Dispatchers.IO) {
            try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(Uri.parse(uri))
                    ?.use { BitmapFactory.decodeStream(it, null, bounds) }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = sampleSizeFor(bounds.outWidth, maxPx)
                }
                context.contentResolver.openInputStream(Uri.parse(uri))
                    ?.use { BitmapFactory.decodeStream(it, null, options) }
                    ?.asImageBitmap()
            } catch (error: Exception) {
                HelmLog.w(HelmLog.CLIENT, "a pulled image could not be decoded for preview")
                null
            }
        }
    }

    preview?.let { bitmap ->
        Image(
            bitmap = bitmap,
            contentDescription = filename,
            contentScale = if (fullScreen) ContentScale.Fit else ContentScale.FillWidth,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .padding(bottom = HelmSpacing.Xs),
        )
    }
}

/** The smallest power-of-two shrink that gets the width under [target]. */
private fun sampleSizeFor(width: Int, target: Int): Int {
    var sample = 1
    while (width > 0 && width / sample > target) sample *= 2
    return sample
}

private const val PREVIEW_MAX_PX = 1080

/** Sizes as a person reads them. One decimal past KB — bytes are not news. */
private fun formatBytes(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

@Composable
private fun ComfyGalleryStrip(
    items: List<ChatAttachment>,
    includedIds: Set<String>,
    maxReferences: Int,
    pulls: Map<String, PullState>,
    onToggle: (ChatAttachment, Boolean) -> Unit,
    onDownload: (ChatAttachment) -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(vertical = HelmSpacing.Xs),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.comfy_gallery_title), color = HelmColors.Txt, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.weight(1f))
            Text(
                stringResource(R.string.comfy_gallery_ref_count, includedIds.size, maxReferences),
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        LazyRow(
            contentPadding = PaddingValues(horizontal = HelmSpacing.Gutter),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            items(items, key = { it.attachmentId }) { attachment ->
                val included = attachment.attachmentId in includedIds
                val key = artifactAttachmentKey(attachment.artifactId, attachment.attachmentId)
                val state = pulls[key] ?: PullState.Idle
                ComfyGalleryTile(
                    attachment = attachment,
                    included = included,
                    state = state,
                    onToggle = { onToggle(attachment, it) },
                    onDownload = { onDownload(attachment) },
                    onOpen = onOpen,
                )
            }
        }
    }
}

@Composable
private fun ComfyGalleryTile(
    attachment: ChatAttachment,
    included: Boolean,
    state: PullState,
    onToggle: (Boolean) -> Unit,
    onDownload: () -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    var previewOpen by remember(attachment.artifactId, attachment.attachmentId) { mutableStateOf(false) }
    Column(
        modifier = Modifier.width(116.dp).clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Bg).padding(HelmSpacing.Xs),
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().heightIn(min = 76.dp, max = 76.dp)
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .clickable { previewOpen = true },
            contentAlignment = Alignment.Center,
        ) {
            if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
                AttachmentPreview(state.uri, attachment.filename)
            } else {
                Text(
                    stringResource(if (state is PullState.Pulling) R.string.comfy_gallery_loading else R.string.comfy_gallery_tap_view),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Checkbox(checked = included, onCheckedChange = onToggle)
        Text(
            attachment.filename,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
    }

    if (previewOpen) {
        Dialog(
            onDismissRequest = { previewOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(
                modifier = Modifier.fillMaxSize().background(HelmColors.Bg).padding(HelmSpacing.Md),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(attachment.filename, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 1)
                    Text(stringResource(R.string.comfy_gallery_close), color = HelmColors.Accent, modifier = Modifier.clickable { previewOpen = false }.padding(HelmSpacing.Sm))
                }
                Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
                        AttachmentPreview(state.uri, attachment.filename, maxPx = 2400, fullScreen = true)
                    } else {
                        Text(
                            when (state) {
                                is PullState.Pulling -> stringResource(R.string.comfy_gallery_saving, formatBytes(state.received), formatBytes(state.total))
                                is PullState.Failed -> state.message
                                PullState.Idle -> stringResource(R.string.comfy_gallery_save_to_preview)
                                is PullState.Ready -> stringResource(R.string.comfy_gallery_preview_unavailable)
                            },
                            color = HelmColors.Dim,
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md), verticalAlignment = Alignment.CenterVertically) {
                    when (state) {
                        is PullState.Ready -> {
                            Text(state.location, color = HelmColors.Dim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f), maxLines = 1)
                            Text("Open", color = HelmColors.Accent, modifier = Modifier.clickable { onOpen(state.uri, attachment.mimeType) }.padding(HelmSpacing.Sm))
                        }
                        is PullState.Pulling -> Text("Saving…", color = HelmColors.Dim)
                        else -> Text(stringResource(R.string.comfy_gallery_save), color = HelmColors.Accent, modifier = Modifier.clickable(onClick = onDownload).padding(HelmSpacing.Sm))
                    }
                }
            }
        }
    }
}

private fun inputImageName(path: String): String = path.substringAfterLast('/').substringAfterLast('\\')

/**
 * The prompt-cache line above the thread: orange past the short cache, red
 * past the long one (the desktop is about to freeze it), blue once frozen —
 * with the way out. Re-reads the clock each minute.
 */
@Composable
private fun CacheBanner(session: HelmSession, onUnfreeze: () -> Unit) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }
    val (text, color) = when (session.cacheStage(now)) {
        CacheStage.Fresh -> return
        CacheStage.Warn -> stringResource(R.string.cache_banner_warn, session.cacheWarnMinutes) to HelmColors.CacheWarn
        CacheStage.Expired -> stringResource(R.string.cache_banner_expired, session.cacheExpireMinutes) to HelmColors.CacheExpired
        CacheStage.Frozen -> stringResource(R.string.cache_banner_frozen) to HelmColors.Frozen
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = text, color = color, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        if (session.frozen) BubbleAction(R.string.chat_unfreeze_glyph, R.string.chat_unfreeze, HelmColors.Frozen, onUnfreeze)
    }
}

@Composable
private fun BubbleNote(textRes: Int, color: Color) {
    Text(
        text = stringResource(textRes),
        color = color,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(top = HelmSpacing.Xs, start = HelmSpacing.Sm, end = HelmSpacing.Sm),
    )
}

/** One under-bubble action: glyph, wording, tap. The glyph leads; the whole row is the target. */
@Composable
private fun BubbleAction(glyphRes: Int, labelRes: Int, color: Color, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(HelmRadius.Md))
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = stringResource(glyphRes),
            color = color,
            style = MaterialTheme.typography.labelMedium,
        )
        Text(
            text = stringResource(labelRes),
            color = color,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
private fun Composer(
    draft: TextFieldValue,
    onDraft: (TextFieldValue) -> Unit,
    onTerminal: () -> Unit,
    onCall: (() -> Unit)?,
    onAttach: (() -> Unit)?,
    onSend: (String) -> Unit,
    allowEmpty: Boolean = false,
) {
    Hairline()
    val dictation = rememberDictation(draft = draft, onDraft = onDraft, onSubmit = onSend)
    if (dictation.message != null) ComposerNote(dictation.message)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(HelmSpacing.Md)
            // A growing draft lifts the composer smoothly rather than snapping.
            .animateContentSize(),
        // Bottom-anchored: a multiline draft grows the field upward, and the
        // three circles stay where the thumb rests instead of riding to centre.
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        ComposerDraft(
            draft = draft,
            onDraft = onDraft,
            modifier = Modifier.weight(1f).heightIn(min = STACKED_CONTROLS_HEIGHT),
        )

        // The circles always stand on end along the right edge — the composer is
        // one solid block at every draft size, never a row that reorganises
        // under the thumb when the text wraps. Same order, send still last.
        Column(
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            horizontalAlignment = Alignment.End,
        ) {
            ComposerTerminal(onTerminal)
            ComposerVoice(dictation = dictation, onCall = onCall)
            ComposerSend(hasText = draft.text.isNotBlank(), allowEmpty = allowEmpty, onSend = { onSend(draft.text) }, onAttach = onAttach)
        }
    }
}

/** A line of voice trouble, said where the user is standing. */
@Composable
private fun ComposerNote(messageRes: Int) {
    Text(
        text = stringResource(messageRes),
        color = HelmColors.Danger,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
    )
}

@Composable
private fun ComposerDraft(
    draft: TextFieldValue,
    onDraft: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Bg)
            .border(HelmSize.Hairline, HelmColors.Accent.copy(alpha = 0.65f), RoundedCornerShape(HelmRadius.Md))
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Md),
    ) {
        if (draft.text.isEmpty()) {
            Text(
                text = stringResource(R.string.chat_placeholder),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        BasicTextField(
            value = draft,
            onValueChange = onDraft,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
            cursorBrush = SolidColor(HelmColors.Accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// The terminal preview is deliberately the same Snapshot journey as the
// overflow action: one pull/navigation path, merely reachable where a
// user is already composing a reply.
@Composable
private fun ComposerTerminal(onTerminal: () -> Unit) {
    val terminalLabel = stringResource(R.string.control_action_snapshot)
    Box(
        modifier = Modifier
            .size(HelmSize.MicButton)
            .clip(CircleShape)
            .background(HelmColors.Accent)
            .clickable(onClick = onTerminal),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "🖥",
            color = HelmColors.OnAccent,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { contentDescription = terminalLabel },
        )
    }
}

/**
 * The mic is permanent and first-class, not an option inside a keyboard: away
 * from the desk it is the primary way a reply gets written, so it holds the
 * thumb position and send sits beside it.
 *
 * Hold to talk. It is a press, not a tap, because that is the gesture that has
 * an obvious end — releasing — and because a dictation nobody ended is a
 * microphone left open. While held it wears a halo that breathes with what the
 * recogniser is hearing: a flat ring while someone speaks is how you tell the
 * microphone is being held by something else.
 */
@Composable
private fun ComposerVoice(dictation: DictationHandle, onCall: (() -> Unit)?) {
    val context = LocalContext.current
    val prefs = remember { context.applicationContext.getSharedPreferences(VOICE_PREFS, Context.MODE_PRIVATE) }
    var mode by remember { mutableStateOf(VoiceMode.of(prefs.getString(VOICE_MODE_KEY, null))) }
    var choosing by remember { mutableStateOf(false) }
    val choose: (VoiceMode) -> Unit = { next ->
        mode = next
        choosing = false
        prefs.edit().putString(VOICE_MODE_KEY, next.name).apply()
    }

    Box {
        when (mode) {
            VoiceMode.Mic -> ComposerMic(dictation = dictation, onSlideUp = { choosing = true })
            VoiceMode.Phone -> ComposerPhone(onCall = onCall, onLongPress = { choosing = true })
        }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.voice_mode_mic)) },
                onClick = { choose(VoiceMode.Mic) },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.voice_mode_phone)) },
                onClick = { choose(VoiceMode.Phone) },
            )
        }
    }
}

/**
 * The composer's one voice button, Telegram-style: it is either the mic (hold
 * to dictate) or the phone (tap to call). Sliding up off a held mic, or holding
 * the phone, offers the other. The choice is remembered.
 */
private enum class VoiceMode {
    Mic, Phone;

    companion object {
        fun of(name: String?): VoiceMode = entries.firstOrNull { it.name == name } ?: Mic
    }
}

/**
 * Hold to dictate. While held it wears a halo that breathes with what the
 * recogniser is hearing: a flat ring while someone speaks is how you tell the
 * microphone is being held by something else. Sliding up abandons the
 * dictation and asks for the mode switch instead.
 */
@Composable
private fun ComposerMic(dictation: DictationHandle, onSlideUp: () -> Unit) {
    val halo by animateFloatAsState(
        targetValue = if (dictation.listening) MIN_HALO + (1f - MIN_HALO) * dictation.level else 0f,
        label = "micHalo",
    )
    val accent = HelmColors.Accent
    val micLabel = stringResource(R.string.voice_mic_hold)
    val slidePx = with(LocalDensity.current) { SLIDE_TO_SWITCH.toPx() }

    // The handle changes on every loudness reading. Keying the gesture on it
    // would restart the pointer filter mid-hold — cancelling the very press it
    // is meant to be tracking — so the gesture is installed once and reads the
    // latest handle through this.
    val current by rememberUpdatedState(dictation)
    val currentSlideUp by rememberUpdatedState(onSlideUp)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }

    HoldHint(pressed) {
        Box(
            modifier = Modifier
                .size(HelmSize.MicButton)
                .drawBehind {
                    if (halo <= 0f) return@drawBehind
                    val core = size.minDimension / 2
                    // Wider is fainter, so the fall-off reads as light, not rings.
                    drawCircle(accent.copy(alpha = 0.10f * halo), radius = core + HALO_SPREAD.toPx() * halo)
                    drawCircle(accent.copy(alpha = 0.22f * halo), radius = core + HALO_SPREAD.toPx() * halo * 0.5f)
                }
                .clip(CircleShape)
                .background(accent)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        pressed = true
                        current.onPress()
                        var slid = false
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) break
                            if (down.position.y - change.position.y > slidePx) {
                                slid = true
                                break
                            }
                        }
                        // A finger lifted and a gesture the system took away are the
                        // same "stop"; a slide up keeps nothing and switches modes.
                        pressed = false
                        if (slid) {
                            current.onCancel()
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            currentSlideUp()
                        } else {
                            current.onRelease()
                        }
                    }
                }
                .semantics { contentDescription = micLabel },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.voice_mic_glyph),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** Tap to call; hold for the mode switch. Dark while a call elsewhere is live. */
@Composable
private fun ComposerPhone(onCall: (() -> Unit)?, onLongPress: () -> Unit) {
    val label = stringResource(R.string.control_action_call)
    val currentCall by rememberUpdatedState(onCall)
    val currentLongPress by rememberUpdatedState(onLongPress)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }
    HoldHint(pressed, onAccent = onCall != null) {
        Box(
            modifier = Modifier
                .size(HelmSize.MicButton)
                .clip(CircleShape)
                .background(if (onCall != null) HelmColors.Accent else HelmColors.Surface2)
                .pointerInput(Unit) {
                    detectTapGestures(
                        onPress = {
                            pressed = true
                            tryAwaitRelease()
                            pressed = false
                        },
                        onTap = { currentCall?.invoke() },
                        onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            currentLongPress()
                        },
                    )
                }
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.control_glyph_call),
                color = if (onCall != null) HelmColors.OnAccent else HelmColors.Dim,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

// Send is a circle like the mic, not a caption: the composer's controls
// read as one pair, and the one that delivers sits last — where a thumb
// already is. Until there is something to send it is dark — an enabled
// control that does nothing is worse than a visibly dead one.
//
// Like the voice button it has two modes, switched by holding it: Send, and
// Attach (📎, tap to pick a file). Typed text always wins — with words in the
// box the button sends, so attach mode can never swallow a message.
@Composable
private fun ComposerSend(hasText: Boolean, allowEmpty: Boolean, onSend: () -> Unit, onAttach: (() -> Unit)?) {
    val context = LocalContext.current
    val prefs = remember { context.applicationContext.getSharedPreferences(VOICE_PREFS, Context.MODE_PRIVATE) }
    var attachMode by remember { mutableStateOf(prefs.getBoolean(ATTACH_MODE_KEY, false)) }
    var choosing by remember { mutableStateOf(false) }
    val choose: (Boolean) -> Unit = { next ->
        attachMode = next
        choosing = false
        prefs.edit().putBoolean(ATTACH_MODE_KEY, next).apply()
    }
    val attaching = attachMode && !hasText && !allowEmpty && onAttach != null
    val enabled = hasText || allowEmpty || attaching
    val currentSend by rememberUpdatedState(onSend)
    val currentAttach by rememberUpdatedState(onAttach)
    val currentAttaching by rememberUpdatedState(attaching)
    val sendLabel = stringResource(if (attaching) R.string.chat_attach else R.string.chat_send)
    val haptics = LocalHapticFeedback.current
    var pressed by remember { mutableStateOf(false) }
    Box {
        HoldHint(pressed, holdable = onAttach != null, onAccent = enabled) {
            Box(
                modifier = Modifier
                    .size(HelmSize.MicButton)
                    .clip(CircleShape)
                    .background(if (enabled) HelmColors.Accent else HelmColors.Surface2)
                    .then(
                        if (enabled) Modifier else Modifier.border(HelmSize.Hairline, HelmColors.Line, CircleShape),
                    )
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onPress = {
                                pressed = currentAttach != null
                                tryAwaitRelease()
                                pressed = false
                            },
                            onTap = { if (currentAttaching) currentAttach?.invoke() else currentSend() },
                            // Nothing to switch to without an attach path.
                            onLongPress = {
                                if (currentAttach != null) {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    choosing = true
                                }
                            },
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(if (attaching) R.string.chat_attach_glyph else R.string.chat_send_glyph),
                    // Dim rather than Faint while disabled: Faint is the placeholder's
                    // colour, and a send arrow in it disappears against the Surface2
                    // circle — which reads as a layout hole, not a dead button.
                    color = if (enabled) HelmColors.OnAccent else HelmColors.Dim,
                    style = HelmType.SendGlyph,
                    modifier = Modifier.semantics { contentDescription = sendLabel },
                )
            }
        }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.send_mode_send)) }, onClick = { choose(false) })
            DropdownMenuItem(text = { Text(stringResource(R.string.send_mode_attach)) }, onClick = { choose(true) })
        }
    }
}

/**
 * Says a composer circle has a second, HELD action. At rest: a small dot on
 * its rim. While held: the circle grows over exactly the long-press time and a
 * ^ rises above it, so the hold visibly fills up to the moment the menu opens
 * — letting go before then is just a tap.
 *
 * [onAccent]: the button is filled with the accent, so the dot is drawn light;
 * on a greyed-out button the same light dot vanishes, so it is drawn in the
 * accent instead — the hint must read on both.
 */
@Composable
private fun HoldHint(pressed: Boolean, holdable: Boolean = true, onAccent: Boolean = true, content: @Composable () -> Unit) {
    val holdMs = LocalViewConfiguration.current.longPressTimeoutMillis.toInt()
    val scale by animateFloatAsState(
        targetValue = if (pressed) HOLD_SCALE else 1f,
        animationSpec = tween(durationMillis = if (pressed) holdMs else HOLD_RELEASE_MS),
        label = "holdHint",
    )
    Box(contentAlignment = Alignment.Center) {
        Box(modifier = Modifier.graphicsLayer { scaleX = scale; scaleY = scale }) { content() }
        if (!holdable) return@Box
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(x = -HOLD_DOT_INSET, y = -HOLD_DOT_INSET)
                .size(HOLD_DOT)
                .clip(CircleShape)
                .background(if (onAccent) HelmColors.OnAccent.copy(alpha = 0.8f) else HelmColors.Accent),
        )
        if (pressed) {
            Text(
                text = stringResource(R.string.hold_hint_arrow),
                color = HelmColors.Accent,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.align(Alignment.TopCenter).offset(y = -HOLD_ARROW_RISE),
            )
        }
    }
}

private const val HOLD_SCALE = 1.25f
private const val HOLD_RELEASE_MS = 120
private val HOLD_DOT = 5.dp
private val HOLD_DOT_INSET = 6.dp
private val HOLD_ARROW_RISE = 18.dp

/** A bubble never spans the full width: the gutter is what says who is talking. */
private const val BUBBLE_WIDTH_FRACTION = 0.75f
private const val SESSION_SWITCH_MS = 220

/** Accent wash behind a selected row: visible on true black, text still readable. */
private const val SELECTED_TINT = 0.16f

/**
 * The three circles stacked with their gaps — the composer field's minimum
 * height, so the box and the controls beside it always read as one block.
 */
private val STACKED_CONTROLS_HEIGHT = HelmSize.MicButton * 3 + HelmSpacing.Sm * 2

/** The pulled-in tail corner. See Bubble. */
private val BUBBLE_TAIL = 5.dp

/** How far the listening halo reaches past the mic at full loudness. */
private val HALO_SPREAD = 14.dp

/** A held mic glows even in silence: the halo says "open", the swell says "heard". */
private const val MIN_HALO = 0.35f

/** How far up a held mic must slide to become the mode switch. */
private val SLIDE_TO_SWITCH = 48.dp

private const val VOICE_PREFS = "helm_composer"
private const val VOICE_MODE_KEY = "voice_mode"
private const val ATTACH_MODE_KEY = "send_attach_mode"

/** Immutable, so one instance serves every bubble. Compose is single-threaded anyway. */
private val bubbleTime = java.time.format.DateTimeFormatter.ofPattern("HH:mm")

/** The mockup shows "09:38" — local wall-clock, the only clock the reader has. */
private fun formatBubbleTime(at: Long): String =
    bubbleTime.format(java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()))
