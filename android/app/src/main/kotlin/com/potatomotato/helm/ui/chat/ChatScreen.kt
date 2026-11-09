package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.ui.call.CallPanel
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.voice.CallPhase
import com.potatomotato.helm.voice.VoiceCallService
import com.potatomotato.helm.ui.sessions.SessionRows
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.activity.compose.BackHandler
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
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
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.Draft
import com.potatomotato.helm.data.attachToDraft
import com.potatomotato.helm.data.PrefsDraftStore
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.nextComfyReferenceSelection
import com.potatomotato.helm.data.rangeSelection
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
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
    onDeleteGalleryAttachment: (ChatAttachment) -> Unit = {},
    onGalleryDownload: (ChatAttachment) -> Unit = {},
    onGalleryPreview: (ChatAttachment) -> Unit = {},
    onGallerySavePreview: (ChatAttachment, uri: String) -> Unit = { _, _ -> },
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
    // One list state PER THREAD, seeded from where that thread was left (see
    // ChatScrollMemory) — a single shared state carried one thread's scroll
    // into the next on every swipe.
    val scrollSpot = remember(sessionId) { ChatScrollMemory.Process.recall(sessionId) }
    val listState = remember(sessionId) { LazyListState(scrollSpot?.index ?: 0, scrollSpot?.offset ?: 0) }
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
    val persistedIncludedGalleryIds = knownGalleryIds - excludedComfyReferenceIds
    var selectedGalleryIds by remember(sessionId) { mutableStateOf(persistedIncludedGalleryIds) }
    LaunchedEffect(knownGalleryIds, excludedComfyReferenceIds) {
        selectedGalleryIds = persistedIncludedGalleryIds
    }
    val includedGalleryIds = selectedGalleryIds
    LaunchedEffect(sessionId, session?.comfyUiTool) {
        if (session?.comfyUiTool == true) onRefreshComfyGallery()
    }
    LaunchedEffect(knownGalleryIds, includedGalleryIds, comfyMaxGalleryReferences) {
        if (includedGalleryIds.size > comfyMaxGalleryReferences) {
            val latestAllowed = comfyGallery.asSequence().map { it.attachmentId }
                .filter { it in includedGalleryIds }.toList().takeLast(comfyMaxGalleryReferences).toSet()
            selectedGalleryIds = latestAllowed
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

    // Follow the conversation, but only from the bottom. A user who has scrolled
    // up is READING; yanking them back on every arriving message — or on a
    // reconnect that delivers a backlog — loses their place. So "following" is
    // decided when a scroll SETTLES, never from the layout after a message has
    // already landed (by then the new bubble has pushed the bottom away). A
    // thread with no remembered spot starts following, which is also what
    // anchors it at the newest bubble. The first emission is the idle state at
    // composition, before the list has measured — not a scroll — so it's dropped.
    var following by remember(sessionId) { mutableStateOf(scrollSpot == null) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .drop(1)
            .filter { !it }
            .collect {
                following = !listState.canScrollForward
                ChatScrollMemory.Process.settle(
                    sessionId,
                    atEnd = following,
                    index = listState.firstVisibleItemIndex,
                    offset = listState.firstVisibleItemScrollOffset,
                )
            }
    }

    // The tail's identity AND size: a reply that grows in place, or a pending
    // row that gains an attachment, must keep the bottom in view just like a
    // new row does. The user's own send always follows — they wrote it.
    //
    // A programmatic jump starts and ends inside one frame, so the settle
    // watcher above never sees it — every jump declares "following" itself.
    suspend fun jumpToEnd() {
        listState.scrollToBottom(messages.lastIndex)
        following = true
        ChatScrollMemory.Process.settle(sessionId, atEnd = true, index = 0, offset = 0)
    }
    val tail = messages.lastOrNull()
    LaunchedEffect(tail?.key, tail?.text?.length, tail?.attachment != null) {
        if (tail != null && (following || tail.fromPhone)) jumpToEnd()
    }

    // The keyboard opening shrinks the thread from the bottom, which on its own
    // leaves the newest lines hidden behind where the composer just was. Reading
    // (not consuming) the IME inset is allowed — insets stay owned by HelmTheme;
    // see InsetsOwnedByThemeTest for the line between the two.
    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(imeBottom) {
        if (imeBottom > 0 && messages.isNotEmpty()) jumpToEnd()
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
                        val swipeHint = earlierUnreadSessions > 0 || laterUnreadSessions > 0
                        if (!following && messages.isNotEmpty()) {
                            JumpToBottomButton(
                                onClick = { swipeScope.launch { jumpToEnd() } },
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(end = HelmSpacing.Gutter, bottom = if (swipeHint) 56.dp else HelmSpacing.Md),
                            )
                        }
                        if (swipeHint) {
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
                      val next = nextComfyReferenceSelection(
                          selectedGalleryIds, attachment.attachmentId, included, comfyMaxGalleryReferences,
                      )
                      selectedGalleryIds = next
                      onComfyReferenceSelection(knownGalleryIds, next)
                  },
                  onDownload = onGalleryDownload,
                  onPreview = onGalleryPreview,
                  onSavePreview = onGallerySavePreview,
                  onDelete = onDeleteGalleryAttachment,
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
                            val next = attachToDraft(Draft(draft.text, draft.selection.min), path)
                            draft = TextFieldValue(next.text, TextRange(next.caret))
                            drafts.save(sessionId, next)
                        }
                    }
                }
            },
            onSend = { submitted ->
                val text = submitted.trim()
                val selectedIds = comfyGallery.asSequence().map { it.attachmentId }
                    .filter { it in selectedGalleryIds }.toList().takeLast(comfyMaxGalleryReferences)
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
                (comfyInputImagePath != null || selectedGalleryIds.isNotEmpty()),
          )
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

/** Shown only while the reader is scrolled up; landing at the end resumes following. */
@Composable
private fun JumpToBottomButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.chat_jump_to_bottom)
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(HelmSize.MicButton)
            .clip(CircleShape)
            .background(HelmColors.Accent)
            .border(HelmSize.Hairline, HelmColors.Bg, CircleShape)
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
    ) {
        Text(text = "↓", color = HelmColors.OnAccent, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    }
}

private const val SESSION_SWITCH_MS = 220

/**
 * The true end of the thread, not the top of the last bubble: a reply taller
 * than the viewport would otherwise leave its newest lines below the fold. The
 * oversized offset is clamped by the list to its maximum scroll.
 */
private suspend fun LazyListState.scrollToBottom(lastIndex: Int) = scrollToItem(lastIndex, Int.MAX_VALUE)
