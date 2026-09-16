package com.potatomotato.helm.ui

import android.app.Activity
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.HelmApp
import com.potatomotato.helm.R
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.ble.HelmLinkService
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.log.LogExport
import com.potatomotato.helm.log.LogExportResult
import com.potatomotato.helm.notify.PendingOpen
import com.potatomotato.helm.save.AndroidArtifactFiles
import com.potatomotato.helm.save.AndroidLogFiles
import com.potatomotato.helm.ui.artifacts.ArtifactDetailScreen
import com.potatomotato.helm.ui.artifacts.ArtifactEdit
import com.potatomotato.helm.ui.artifacts.ArtifactEditorScreen
import com.potatomotato.helm.ui.artifacts.ArtifactsScreen
import com.potatomotato.helm.ui.chat.ChatScreen
import com.potatomotato.helm.ui.components.DialogAction
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.ScrimDialog
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.components.SessionTabs
import com.potatomotato.helm.ui.control.ActionNoticeBar
import com.potatomotato.helm.ui.control.SessionSheet
import com.potatomotato.helm.ui.control.SnapshotScreen
import com.potatomotato.helm.ui.control.SpawnScreen
import com.potatomotato.helm.ui.pairing.AwaitingDesktopScreen
import com.potatomotato.helm.ui.pairing.DesktopsScreen
import com.potatomotato.helm.ui.sessions.SessionListScreen
import com.potatomotato.helm.ui.voice.VoiceScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Where an open session can take you. One straight path still — the sheet and the
 * screens it opens all hang off [Destination.Thread], never off each other.
 *
 * [Destination.Thread] is not the chat alone: it is the session's TAB surface
 * (chat or artifact list, see [SessionTab]), which is why the artifact detail and
 * editor return to it rather than to a screen of their own.
 */
private enum class Destination { Thread, Voice, Sheet, Snapshot, Spawn, ArtifactDetail, ArtifactEditor, Desktops, Pairing }

/**
 * The screens the user lives in, and the navigation between them.
 *
 * Navigation is a nullable session id plus a destination rather than a nav
 * library: the graph is a star around one thread, and a graph definition would be
 * more machinery than the thing it describes. Both are [rememberSaveable] so a
 * rotation does not drop the user back to the list, out of a dictation they are
 * halfway through, or out of a snapshot they are reading.
 */
@Composable
fun HelmHome(client: HelmClient = HelmPairing.client, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val linkState by HelmLink.state.collectAsState()
    val sessions by client.sessions.sessions.collectAsState()
    val reach by client.sessions.reach.collectAsState()
    val threads by client.chats.threads.collectAsState()
    val capabilities by client.capabilities.state.collectAsState()
    val snapshot by client.control.snapshot.collectAsState()
    val requestedLines by client.control.requestedLines.collectAsState()
    val notice by client.control.notice.collectAsState()
    val directories by client.control.directories.collectAsState()
    val directoriesError by client.control.directoriesError.collectAsState()
    val clis by client.control.clis.collectAsState()
    val createdSessionId by client.control.createdSessionId.collectAsState()
    val artifactList by client.artifacts.list.collectAsState()
    val artifactRead by client.artifacts.read.collectAsState()
    val artifactSave by client.artifacts.save.collectAsState()
    val artifactLanding by client.control.artifactLanding.collectAsState()
    val notificationsEnabled by client.alerts.enabled.collectAsState()
    val desktops by HelmPairing.desktops.collectAsState()
    var openSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    // Deliberately NOT saveable: a rotation must not redraw a question the user
    // never asked, and back is one tap away if they still mean it.
    var leaving by remember { mutableStateOf(false) }
    var where by rememberSaveable { mutableStateOf(Destination.Thread) }
    // Which of the open session's tabs is showing. Saveable for the same reason
    // [where] is: a rotation must not drop a user reading the artifact list back
    // into the conversation.
    var tab by rememberSaveable { mutableStateOf(SessionTab.Chat) }
    var openArtifactId by rememberSaveable { mutableStateOf<String?>(null) }
    // The editor's payload, kept saveable so a rotation or a process death can
    // never turn a half-written revise into a create: the id names the mode
    // (null is create) and the shown body is what a revise starts from. The
    // artifact itself is re-derived from the list, which is re-pulled on arrival.
    var editingArtifactId by rememberSaveable { mutableStateOf<String?>(null) }
    var editingShown by rememberSaveable { mutableStateOf<String?>(null) }

    PollSessions(client)

    // A notification tap lands in that session's THREAD — or, for an artifact
    // row, in its ARTIFACTS. Neither adds a row to the thread: an alert is an
    // event Helm reported, never something an agent said.
    val tapped by PendingOpen.target.collectAsState()
    LaunchedEffect(tapped) {
        PendingOpen.consume()?.let { target ->
            openSessionId = target.sessionId
            tab = if (target.artifacts) SessionTab.Artifacts else SessionTab.Chat
            where = Destination.Thread
        }
    }

    // What the notifier needs to know to stay quiet about the thing on screen —
    // and to clear rows the user has just answered by opening them. The
    // artifacts screens count as reading the session too: opening the list is
    // answering every artifact buzz for it.
    ReportVisibility(client)
    LaunchedEffect(openSessionId, where) {
        val reading = where == Destination.Thread ||
            where == Destination.ArtifactDetail || where == Destination.ArtifactEditor
        client.alerts.opened(openSessionId?.takeIf { reading })
    }

    val open = sessions.firstOrNull { it.id == openSessionId }
    if (openSessionId != null && open == null && sessions.isNotEmpty()) {
        // The session went away while it was on screen. Fall back to the list
        // rather than leaving the user in a thread that can no longer be replied to.
        openSessionId = null
        where = Destination.Thread
    }

    // The permitted surface is asked for when a control surface needs it and is
    // forgotten with the link, so a reconnect re-asks and a capability revoked on
    // the desktop stops being offered. The list needs it too: its New session
    // button greys from the same answer the sheet does — and so do the artifacts
    // screens, whose New/Revise/Save/Delete rows grey from it.
    LaunchedEffect(where, tab, openSessionId, capabilities) {
        val listShowing = openSessionId == null && where != Destination.Spawn
        val artifactsShowing = (where == Destination.Thread && tab == SessionTab.Artifacts) ||
            where == Destination.ArtifactDetail || where == Destination.ArtifactEditor
        if ((where == Destination.Sheet || listShowing || artifactsShowing) && capabilities is Capabilities.Unknown) {
            client.refreshCapabilities()
        }
    }
    LaunchedEffect(where, tab, openSessionId) {
        when {
            where == Destination.Spawn -> {
                if (directories.isEmpty()) client.refreshDirectories()
                if (clis.isEmpty()) client.refreshClis()
            }
            // The artifacts screens pull on arrival, like a snapshot pull: a
            // fresh ask every visit, never a stream and never a stale cache.
            // This is also why the artifact writes need no follow-up ask of
            // their own — returning from one re-pulls what it changed. Switching
            // TO the tab is an arrival; switching away and back pulls again.
            where == Destination.Thread && tab == SessionTab.Artifacts ->
                openSessionId?.let { client.refreshArtifacts(it) }
            where == Destination.ArtifactDetail ->
                if (openSessionId != null && openArtifactId != null) {
                    client.readArtifact(openSessionId!!, openArtifactId!!, version = null)
                }
            else -> {}
        }
    }

    // A spawn Helm confirmed names the session it made, and that id is how the
    // new thread opens. The opening WAITS until the row is actually in the
    // list: jumping straight there would trip the went-away fallback above (the
    // next 2s poll has not shown the session yet) and dump the user back on the
    // list. A session that never appears gives up quietly — the notice bar has
    // already said the spawn succeeded, and the list is one poll away.
    LaunchedEffect(createdSessionId) {
        val id = createdSessionId ?: return@LaunchedEffect
        var polls = 0
        // No refreshSessions() here on purpose: PollSessions below is already
        // polling every 2s while this screen is visible; a second caller would
        // just double the wire traffic for the same list.
        while (client.sessions.sessions.value.none { it.id == id } && polls < CREATED_SESSION_POLLS) {
            delay(POLL_INTERVAL_MS)
            polls++
        }
        client.control.clearCreatedSession(id)
        if (client.sessions.sessions.value.any { it.id == id }) {
            openSessionId = id
            // A newly-created session is an opening just like tapping a list
            // row; never inherit the previous session's artifact tab/detail.
            tab = SessionTab.Chat
            openArtifactId = null
            editingArtifactId = null
            editingShown = null
            where = Destination.Thread
        }
    }

    // An artifact write that LANDED moves the user once. Create opens the new
    // artifact's detail; revise returns to the detail it came from (which
    // re-pulls the fresh body on arrival); delete returns to the list (which
    // re-pulls without the row). Consumed exactly once, so two identical
    // outcomes both navigate and a rotation does not drag anyone anywhere.
    LaunchedEffect(artifactLanding) {
        val landing = artifactLanding ?: return@LaunchedEffect
        client.control.consumeArtifactLanding()
        when (landing.action) {
            SessionAction.CreateArtifact -> {
                val id = landing.artifactId
                if (id == null) {
                    // The answer named no artifact; the list is where the new
                    // row is one pull away.
                    where = Destination.Thread
                } else {
                    openArtifactId = id
                    editingArtifactId = null
                    editingShown = null
                    where = Destination.ArtifactDetail
                }
            }
            SessionAction.ReviseArtifact -> {
                editingArtifactId = null
                editingShown = null
                where = Destination.ArtifactDetail
            }
            SessionAction.DeleteArtifact -> where = Destination.Thread
            else -> {}
        }
    }

    // A downloaded artifact's bytes are not a save until they are on disk. The
    // device sink is the only Android-typed step in the artifacts slice; it
    // lives here at the UI edge, and its outcome is both the Save row's state
    // and the notice the user reads.
    val artifactFiles = remember { AndroidArtifactFiles(context) }
    LaunchedEffect(artifactSave) {
        val ready = artifactSave as? ArtifactSave.Ready ?: return@LaunchedEffect
        try {
            val path = withContext(Dispatchers.IO) {
                artifactFiles.save(ready.file.filename, ready.file.mimeType, ready.file.bytes)
            }
            client.artifacts.saveLanded(ready.file.artifactId, path)
            client.control.noticed(SessionAction.SaveArtifact, ActionOutcome.Done)
        } catch (error: Exception) {
            client.artifacts.saveFailed(
                ready.file.artifactId,
                error.message ?: CANNOT_WRITE_FILE,
            )
        }
    }

    // The log export deliberately does NOT go over the link: the reports it
    // exists to serve are "it says Linked but nothing arrives", so an export
    // that needed the desktop would be broken in exactly the case it is for.
    // Strings are resolved here rather than in the callback — stringResource
    // reads the composition, which a click handler is no longer inside.
    val logFiles = remember { AndroidLogFiles(context) }
    val scope = rememberCoroutineScope()
    val exportSaved = stringResource(R.string.logs_export_saved)
    val exportEmpty = stringResource(R.string.logs_export_empty)
    val exportFailed = stringResource(R.string.logs_export_failed)
    val exportLogs: () -> Unit = {
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                LogExport.export(HelmApp.logs?.snapshot().orEmpty(), logFiles)
            }
            Toast.makeText(
                context,
                when (result) {
                    is LogExportResult.Saved -> exportSaved.format(result.where)
                    LogExportResult.Empty -> exportEmpty
                    is LogExportResult.Failed -> exportFailed.format(result.reason)
                },
                Toast.LENGTH_LONG,
            ).show()
        }
        Unit
    }

    val toThread = { where = Destination.Thread }
    val listedArtifacts = when (val listed = artifactList) {
        is ArtifactList.Ready -> listed.artifacts
        is ArtifactList.Refreshing -> listed.cached
        else -> openSessionId?.let { client.artifacts.cachedArtifacts(it) }.orEmpty()
    }
    // Snapshot has two entry points (overflow and the composer shortcut), but
    // one transition and one initial pull. Keeping that contract here prevents
    // the convenient button drifting from the established context-menu action.
    val openTerminalPreview = {
        where = Destination.Snapshot
        client.readTerminal(open?.id.orEmpty(), requestedLines)
        Unit
    }

    // The editor's payload, built before composition so no branch has to render
    // a form for an edit it cannot name. A revise whose artifact went missing
    // (list emptied under it, a cold process restore) falls back to the list
    // rather than silently becoming a create.
    val edit: ArtifactEdit? = when {
        where != Destination.ArtifactEditor -> null
        editingArtifactId == null -> ArtifactEdit.New(sessionId = open?.id.orEmpty())
        else -> {
            val revised = listedArtifacts.firstOrNull { it.id == editingArtifactId }
                ?: (artifactRead as? ArtifactRead.Done)
                    ?.takeIf { it.read.artifact.id == editingArtifactId }
                    ?.read?.artifact
                ?: (artifactRead as? ArtifactRead.Refreshing)
                    ?.takeIf { it.cached.artifact.id == editingArtifactId }
                    ?.cached?.artifact
            val shown = editingShown
            if (revised != null && shown != null) ArtifactEdit.Revision(revised, shown) else null
        }
    }
    LaunchedEffect(where, edit) {
        if (where == Destination.ArtifactEditor && edit == null) where = Destination.Thread
    }

    Column(modifier = modifier.fillMaxSize()) {
        notice?.let { ActionNoticeBar(notice = it, onDismiss = client.control::clearNotice) }

        Box(modifier = Modifier.fillMaxSize()) {
            when {
                // Spawn is reachable with NO session open — the list's New
                // session button lands here — so it goes first: it touches no
                // session, and putting it above the null check is what lets the
                // branches below keep their non-null smart cast.
                // Same reasoning as Spawn: reachable with no session open, so
                // it sits above the null check rather than inside it.
                where == Destination.Desktops -> {
                    BackHandler(onBack = toThread)
                    DesktopsScreen(
                        desktops = desktops,
                        linkState = linkState,
                        onRename = HelmPairing::rename,
                        onForget = HelmPairing::forget,
                        onBack = toThread,
                    )
                }

                // Reachable with no session open, same as Spawn and Desktops.
                // A desktop connecting mid-wait is not handled here at all: it
                // drives PairingController into Handshaking/Comparing, and
                // HelmRoot's own `when` renders that interstitial ABOVE this
                // composition regardless of `where` — so this branch just stops
                // being drawn rather than needing to navigate itself away.
                where == Destination.Pairing -> {
                    BackHandler(onBack = toThread)
                    AwaitingDesktopScreen(
                        linkState = linkState,
                        onReadvertise = { HelmLinkService.forcePairingMode(context) },
                        onBack = toThread,
                    )
                }

                where == Destination.Spawn -> {
                    BackHandler(onBack = toThread)
                    SpawnScreen(
                        directories = directories,
                        clis = clis,
                        directoriesError = directoriesError,
                        sessions = sessions,
                        linkState = linkState,
                        onSpawn = { dirPath, cliType, name ->
                            // Navigation is decided by the OUTCOME, not by the
                            // tap: success arrives as createdSessionId above,
                            // failure as the notice bar's to say — so the form
                            // keeps its choices instead of leaving on faith.
                            client.spawn(dirPath, cliType, name)
                        },
                        onRetryDirectories = { client.refreshDirectories() },
                        onBack = toThread,
                    )
                }

                open == null -> SessionListScreen(
                    sessions = sessions,
                    linkState = linkState,
                    reach = reach,
                    capabilities = capabilities,
                    onOpen = {
                        openSessionId = it.id
                        // A freshly opened session starts on its conversation —
                        // the tab the LAST session was left on is not a choice
                        // the user made about this one.
                        tab = SessionTab.Chat
                    },
                    // Long-press reuses the star exactly as it is: the pressed
                    // session becomes the focused one with the sheet already up.
                    // The thread behind the sheet names the session the actions
                    // belong to — the same context the scrim gives on the chat.
                    onLongPress = {
                        openSessionId = it.id
                        tab = SessionTab.Chat
                        where = Destination.Sheet
                    },
                    onNewSession = {
                        openSessionId = null
                        where = Destination.Spawn
                    },
                    onPairDesktop = {
                        HelmLinkService.forcePairingMode(context)
                        where = Destination.Pairing
                    },
                    onDesktops = { where = Destination.Desktops },
                    onExportLogs = exportLogs,
                    notificationsEnabled = notificationsEnabled,
                    onToggleNotifications = { client.alerts.setEnabled(!notificationsEnabled) },
                )

                where == Destination.Voice -> VoiceScreen(
                    sessionName = open.name,
                    linkState = linkState,
                    onCancel = toThread,
                    // Sending returns to the thread rather than the list: the
                    // message lands there in its Sending state, so the user sees
                    // where the words went and watches them deliver.
                    onSend = { text ->
                        client.sendChat(open.id, text)
                        where = Destination.Thread
                    },
                )

                where == Destination.Snapshot -> {
                    BackHandler(onBack = toThread)
                    SnapshotScreen(
                        snapshot = snapshot,
                        requestedLines = requestedLines,
                        linkState = linkState,
                        onPull = { lines -> client.readTerminal(open.id, lines) },
                        onBack = toThread,
                    )
                }

                where == Destination.ArtifactEditor && edit != null -> {
                    BackHandler(
                        // Back undoes the edit without a wire call: a create
                        // returns to the list it came from, a revise to the
                        // artifact it was revising.
                        onBack = {
                            where = if (editingArtifactId == null) {
                                Destination.Thread
                            } else {
                                Destination.ArtifactDetail
                            }
                        },
                    )
                    ArtifactEditorScreen(
                        edit = edit,
                        linkState = linkState,
                        onSubmit = { title, content ->
                            if (edit is ArtifactEdit.New) {
                                client.createArtifact(open.id, title, content)
                            } else {
                                val artifactId = editingArtifactId
                                if (artifactId != null) client.reviseArtifact(open.id, artifactId, content)
                            }
                        },
                        onBack = {
                            where = if (editingArtifactId == null) {
                                Destination.Thread
                            } else {
                                Destination.ArtifactDetail
                            }
                        },
                    )
                }

                // The editor's payload went missing under it — the reset effect
                // is one frame away from landing on the list. Nothing renders
                // here, and nothing may: rendering the thread would flash a
                // conversation into a screen the user left.
                where == Destination.ArtifactEditor -> Unit

                where == Destination.ArtifactDetail -> {
                    BackHandler(onBack = toThread)
                    ArtifactDetailScreen(
                        // The row the list showed names the artifact while its
                        // body is still crossing the link; the read state takes
                        // over once it lands.
                        artifact = listedArtifacts.firstOrNull { it.id == openArtifactId },
                        state = artifactRead,
                        saveState = artifactSave,
                        capabilities = capabilities,
                        linkState = linkState,
                        onPull = { version ->
                            openSessionId?.let { session -> client.readArtifact(session, openArtifactId!!, version) }
                        },
                        onRevise = {
                            editingArtifactId = openArtifactId
                            editingShown = when (val current = artifactRead) {
                                is ArtifactRead.Done -> current.read.content
                                is ArtifactRead.Refreshing -> current.cached.content
                                else -> null
                            }
                            where = Destination.ArtifactEditor
                        },
                        onDownload = {
                            openSessionId?.let { session ->
                                client.downloadArtifact(session, openArtifactId!!, version = null)
                            }
                        },
                        onDelete = {
                            openSessionId?.let { session ->
                                client.deleteArtifact(session, openArtifactId!!)
                            }
                        },
                        onBack = toThread,
                    )
                }

                // The session's tab surface — and what the sheet's scrim sits
                // over, which is why Sheet lands here too rather than on a blank
                // screen: the actions must name the session they belong to.
                else -> {
                    val toList = { openSessionId = null }
                    BackHandler(onBack = toList)
                    SessionTabScaffold(
                        sessionName = open.name,
                        linkState = linkState,
                        tab = tab,
                        onSelectTab = { tab = it },
                        onBack = toList,
                        onOverflow = { where = Destination.Sheet },
                    ) {
                        when (tab) {
                            SessionTab.Chat -> ChatScreen(
                                sessionId = open.id,
                                messages = threads[open.id].orEmpty(),
                                onSend = { text -> client.sendChat(open.id, text) },
                                onVoice = { where = Destination.Voice },
                                onTerminal = openTerminalPreview,
                            )

                            SessionTab.Artifacts -> ArtifactsScreen(
                                state = artifactList,
                                capabilities = capabilities,
                                onOpen = { artifact ->
                                    openArtifactId = artifact.id
                                    where = Destination.ArtifactDetail
                                },
                                onNew = {
                                    editingArtifactId = null
                                    editingShown = null
                                    where = Destination.ArtifactEditor
                                },
                            )
                        }
                    }
                }
            }

            // The sheet is an overlay on the thread, not a screen of its own: the
            // conversation stays visible behind the scrim, which is what tells the
            // user which session these actions belong to.
            if (open != null && where == Destination.Sheet) {
                BackHandler(onBack = toThread)
                SessionSheet(
                    sessionName = open.name,
                    capabilities = capabilities,
                    onDismiss = toThread,
                    onAction = { action ->
                        where = when (action) {
                            SessionAction.Snapshot -> Destination.Snapshot
                            SessionAction.Spawn -> Destination.Spawn
                            SessionAction.Compact -> Destination.Thread.also { client.compact(open.id) }
                            SessionAction.Close -> Destination.Thread.also { client.closeSession(open.id) }
                            // Rename never reaches here — it is answered by
                            // onRename below, because it carries a name. The
                            // artifact actions never reach here either: their
                            // rows live on the artifacts tab and the screens
                            // under it, where the thing acted on is visible.
                            SessionAction.Rename -> Destination.Thread
                            else -> Destination.Thread
                        }
                        // A snapshot is pulled as soon as it is asked for, at the
                        // count the chip row already shows (the smallest one before
                        // the first choice): arriving on an empty terminal screen
                        // and having to choose again is a step nobody wants.
                        if (action == SessionAction.Snapshot) client.readTerminal(open.id, requestedLines)
                    },
                    // Back to the thread rather than staying on the sheet: the
                    // notice bar says how it ended and the app bar shows the new
                    // name, which is the same landing every other action gets.
                    onRename = { name ->
                        client.renameSession(open.id, name)
                        where = Destination.Thread
                    },
                )
            }

            // Back at the true root — the session list, nothing open over it.
            //
            // GATED, NOT MERELY LAST: this composes AFTER the branch handlers
            // above, and the dispatcher gives back to the most recently added
            // enabled callback. Without the condition it would swallow every
            // in-app back and offer to quit from halfway down the app.
            //
            // WHY ASK AT ALL: backgrounding keeps the foreground service, and
            // with it the BLE link and the notifications, alive. Quitting drops
            // them. A stray back used to take the destructive option silently.
            val atRoot = openSessionId == null && where == Destination.Thread
            BackHandler(enabled = atRoot) { leaving = !leaving }
            // A notification tap can navigate out from under an open dialog.
            // Drop the question with the screen it was asked on, so returning
            // to the list later does not find it still waiting.
            LaunchedEffect(atRoot) { if (!atRoot) leaving = false }
            if (leaving && atRoot) {
                ExitDialog(
                    onBackground = {
                        leaving = false
                        // moveTaskToBack, never finish(): the task stays in
                        // Recents exactly where the user left it, and the
                        // service keeps the link up behind it.
                        (context as? Activity)?.moveTaskToBack(true)
                    },
                    onQuit = {
                        leaving = false
                        // Quit means QUIT. The foreground service outlives the
                        // activity by design when backgrounding, so finishing
                        // alone leaves the link and its notification running —
                        // observed as "quit doesn't work" with Helm still
                        // online on the desktop afterwards. LAN is the same
                        // story but sneakier: it lives in HelmPairing, not the
                        // service, and its non-daemon pump thread keeps the
                        // whole process — and the socket — alive after finish().
                        HelmPairing.stopLan()
                        HelmLinkService.stop(context)
                        (context as? Activity)?.finish()
                    },
                    onDismiss = { leaving = false },
                )
            }
        }
    }
}

/** The one question back asks at the root. See the BackHandler above for why. */
@Composable
private fun ExitDialog(onBackground: () -> Unit, onQuit: () -> Unit, onDismiss: () -> Unit) {
    ScrimDialog(
        title = stringResource(R.string.exit_title),
        body = stringResource(R.string.exit_body),
        onDismiss = onDismiss,
    ) {
        // Backgrounding leads because it is both the safe answer and the one
        // the user almost always meant by pressing back.
        DialogAction(text = stringResource(R.string.exit_background), onClick = onBackground)
        DialogAction(text = stringResource(R.string.exit_quit), onClick = onQuit, emphasised = false)
        DialogAction(text = stringResource(R.string.exit_cancel), onClick = onDismiss, emphasised = false)
    }
}

/**
 * The chrome an open session wears, whichever tab is showing.
 *
 * One owner for the bar and the tab row means switching tabs re-lays-out only the
 * body: the title, the link badge and the ⋮ do not blink, and neither can drift
 * apart between the two tabs.
 */
@Composable
private fun SessionTabScaffold(
    sessionName: String,
    linkState: LinkState,
    tab: SessionTab,
    onSelectTab: (SessionTab) -> Unit,
    onBack: () -> Unit,
    onOverflow: () -> Unit,
    body: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        HelmAppBar(title = sessionName, linkState = linkState, onBack = onBack, onOverflow = onOverflow)
        SessionTabs(selected = tab, onSelect = onSelectTab)
        Box(modifier = Modifier.weight(1f)) { body() }
    }
}

/**
 * Keep the list fresh while the user can see it — and ONLY while they can.
 *
 * The desktop's per-device budget (120 calls/min) was sized for a visible
 * screen, not a background loop, so the poll is scoped to STARTED: a phone in a
 * pocket spends nothing, and the first poll after it comes out is immediate.
 */
@Composable
private fun PollSessions(client: HelmClient) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                client.refreshSessions()
                delay(POLL_INTERVAL_MS)
            }
        }
    }
}

/**
 * Tell the notifier whether the user can actually see the app.
 *
 * STARTED and not RESUMED is the right line: an app visible behind the pairing
 * dialog is still being looked at, while one in the recents carousel is not.
 * Without this the phone would go silent for a session left open in a pocket —
 * which is precisely the case the whole feature exists for.
 */
@Composable
private fun ReportVisibility(client: HelmClient) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            client.alerts.visible(true)
            try {
                awaitCancellation()
            } finally {
                client.alerts.visible(false)
            }
        }
    }
}

/** Half the per-device budget, leaving room for whatever the user is doing. */
private const val POLL_INTERVAL_MS = 2_000L

/**
 * How long a confirmed spawn waits for its session to show in the list before
 * giving up on opening the thread. The desktop records the session before it
 * answers, so one poll is normally enough — this is the rope, not the path.
 */
private const val CREATED_SESSION_POLLS = 10

/** The sink threw with no message of its own; the row still needs a reason. */
private const val CANNOT_WRITE_FILE = "The phone could not write the file"
