/**
 * useArtifactViewer — module-singleton reactive state for the Artifact panel.
 *
 * Mirrors the useRecycleBin / useRuntimeGroups pattern: refs live at module
 * scope, the use*() accessor returns them, and we subscribe to the artifact
 * IPC events exactly once.
 *
 * Session-awareness: the host component owns "which session is active" and
 * tells this composable via setActiveSession()/refresh(). The change/reveal
 * events carry a sessionId, so we only react when it matches the session the
 * panel is currently bound to. This keeps a single shared panel correct as the
 * user switches sessions, and lets a snap-out window bind to its own session.
 */
import { ref, computed } from 'vue';
import { artifactsClient, eventsClient } from '../ipc/clients.js';
import type { Artifact } from '../../src/types/artifact.js';
import type { ArtifactAttachment } from '../../src/types/artifact-attachment.js';
import { buildTextArtifact, decodeBase64Text, isTextLikeFile } from '../artifacts/text-file-drop.js';

const PANEL_VISIBLE_KEY = 'helm:artifact-panel-visible';

const artifacts = ref<Artifact[]>([]);
const selectedId = ref<string | null>(null);
/** null = follow the latest version; otherwise a pinned 1-based version number. */
const selectedVersion = ref<number | null>(null);
const panelVisible = ref<boolean>(loadBool(PANEL_VISIBLE_KEY, false));
const unread = ref<Set<string>>(new Set());
/** Attachments of the currently-selected artifact (metadata only). */
const attachments = ref<ArtifactAttachment[]>([]);

/** The session the panel is currently bound to (host-driven). */
let activeSessionId: string | null = null;
let subscribed = false;
let refreshRequest = 0;
let creationRequest = 0;
let attachmentsRequest = 0;

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function persistBool(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* ignore */ }
}

/** The currently-selected artifact, or null. */
const selected = computed<Artifact | null>(() =>
  artifacts.value.find(a => a.id === selectedId.value) ?? null,
);

/** Count of unread artifacts for the badge/pulse. */
const unreadCount = computed(() => unread.value.size);

/**
 * Reload the artifact list for a session and keep the selection stable.
 * Auto-selects the newest artifact when nothing valid is selected.
 */
async function refresh(sessionId: string | null = activeSessionId): Promise<void> {
  const request = ++refreshRequest;
  activeSessionId = sessionId;
  if (!sessionId) {
    artifacts.value = [];
    selectedId.value = null;
    attachments.value = [];
    return;
  }
  let list: Artifact[] = [];
  try {
    list = (await artifactsClient.artifactList(sessionId)) ?? [];
  } catch {
    list = [];
  }
  if (request !== refreshRequest || sessionId !== activeSessionId) return;
  artifacts.value = list;

  // Drop unread markers + stale selection for artifacts that no longer exist.
  const live = new Set(list.map(a => a.id));
  pruneUnread(live);
  if (selectedId.value && !live.has(selectedId.value)) selectedId.value = null;

  // Auto-select the newest (list is newest-updated first) when nothing is selected.
  if (!selectedId.value && list.length > 0) {
    selectedId.value = list[0].id;
    selectedVersion.value = null;
    unread.value.delete(list[0].id);
  }

  // Last, so the auto-select above has already settled which artifact is shown.
  void loadAttachments();
}

function pruneUnread(liveIds: Set<string>): void {
  let changed = false;
  for (const id of unread.value) {
    if (!liveIds.has(id)) { unread.value.delete(id); changed = true; }
  }
  if (changed) unread.value = new Set(unread.value);
}

/** Point the panel at a session; clears selection state and reloads. */
async function setActiveSession(sessionId: string | null): Promise<void> {
  if (sessionId === activeSessionId) return;
  activeSessionId = sessionId;
  selectedId.value = null;
  selectedVersion.value = null;
  unread.value = new Set();
  await refresh(sessionId);
}

/** Select an artifact; resets to the latest version and clears its unread dot. */
function select(id: string): void {
  selectedId.value = id;
  selectedVersion.value = null;
  if (unread.value.delete(id)) unread.value = new Set(unread.value);
  void loadAttachments();
}

/** Pin a specific version (1-based) in the detail pane. */
function setVersion(n: number | null): void {
  selectedVersion.value = n;
}

/** Return to following the latest version. */
function jumpToLatest(): void {
  selectedVersion.value = null;
}

function showPanel(): void {
  panelVisible.value = true;
  persistBool(PANEL_VISIBLE_KEY, true);
}

function hidePanel(): void {
  panelVisible.value = false;
  persistBool(PANEL_VISIBLE_KEY, false);
}

/** Delete a single artifact, then reload. */
async function remove(id: string): Promise<void> {
  try { await artifactsClient.artifactDelete(id); } catch { /* ignore */ }
  if (selectedId.value === id) selectedId.value = null;
  if (unread.value.delete(id)) unread.value = new Set(unread.value);
  await refresh();
}

/** Delete every artifact in a session, then reload. */
async function clearAll(sessionId: string | null = activeSessionId): Promise<void> {
  if (!sessionId) return;
  try { await artifactsClient.artifactDeleteAll(sessionId); } catch { /* ignore */ }
  selectedId.value = null;
  unread.value = new Set();
  await refresh(sessionId);
}

/** Export an artifact via the native save dialog; returns the path or null. */
async function exportArtifact(id: string): Promise<string | null> {
  try { return await artifactsClient.artifactExport(id); } catch { return null; }
}

/**
 * Open one artifact version in the OS default app. Unlike the other mutations
 * the failure reason is returned rather than swallowed — on Windows there may be
 * no application registered for .md, and a silently dead button is worse than
 * a message.
 */
async function openExternal(id: string, version?: number): Promise<{ success: boolean; error?: string }> {
  try { return await artifactsClient.artifactOpenExternal(id, version); }
  catch (err) { return { success: false, error: String(err) }; }
}

// ── Manual creation ──────────────────────────────────────────────────────

/** Create a manual text/markdown artifact. Returns the artifact or null. */
async function createTextArtifact(title: string, content: string, kind?: 'markdown' | 'html'): Promise<Artifact | null> {
  const sessionId = activeSessionId;
  const request = ++creationRequest;
  if (!sessionId) return null;
  try {
    const artifact = await artifactsClient.artifactCreateText(sessionId, title, content, kind);
    await refresh(sessionId);
    if (artifact && request === creationRequest && activeSessionId === sessionId) select(artifact.id);
    return artifact ?? null;
  } catch { return null; }
}

/** Create a manual artifact from a base64-encoded file. Returns the artifact or null. */
async function createFileArtifact(input: {
  filename: string;
  contentBase64: string;
  contentType?: string;
}): Promise<Artifact | null> {
  const sessionId = activeSessionId;
  const request = ++creationRequest;
  if (!sessionId) return null;
  try {
    const result = await artifactsClient.artifactCreateWithFile(sessionId, input);
    await refresh(sessionId);
    if (result?.artifact && request === creationRequest && activeSessionId === sessionId) select(result.artifact.id);
    return result?.artifact ?? null;
  } catch { return null; }
}

/**
 * Open a native file picker, read the file, and create an artifact from it.
 * Readable files become readable content (same extension-first rule as drop
 * and paste); only real binaries become attachments.
 */
async function attachFile(): Promise<Artifact | null> {
  try {
    const fileData = await artifactsClient.artifactPickAndReadFile();
    if (!fileData) return null;
    if (isTextLikeFile(fileData.filename, fileData.contentType)) {
      const draft = buildTextArtifact(fileData.filename, decodeBase64Text(fileData.contentBase64));
      return createTextArtifact(draft.title, draft.content);
    }
    return createFileArtifact(fileData);
  } catch { return null; }
}

/** Rename an artifact. Returns true on success. */
async function renameArtifact(id: string, newTitle: string): Promise<boolean> {
  try {
    const success = await artifactsClient.artifactRename(id, newTitle);
    if (success) void refresh();
    return success;
  } catch { return false; }
}

/**
 * Save an edited body as a new version. Returns true on success; false when the
 * main process refused it (blank content) or the id is unknown.
 */
async function updateArtifact(id: string, content: string): Promise<boolean> {
  try {
    const updated = await artifactsClient.artifactUpdate(id, content);
    if (updated) void refresh();
    return updated !== null;
  } catch { return false; }
}

/** Open an attachment in the system's default app. */
async function openAttachment(artifactId: string, attachmentId: string): Promise<boolean> {
  try { return await artifactsClient.artifactOpenAttachment(artifactId, attachmentId); } catch { return false; }
}

// ── Attachments on the selected artifact ──────────────────────────────────

/** Reload the attachment list for the selected artifact (stale-safe). */
async function loadAttachments(): Promise<void> {
  const request = ++attachmentsRequest;
  const artifactId = selectedId.value;
  if (!artifactId) {
    attachments.value = [];
    return;
  }
  let list: ArtifactAttachment[] = [];
  try {
    list = (await artifactsClient.artifactAttachmentList(artifactId)) ?? [];
  } catch {
    // A transient IPC failure keeps whatever we had — rows only leave the
    // screen when a successful list (or a switch) says so.
    return;
  }
  if (request !== attachmentsRequest || selectedId.value !== artifactId) return;
  attachments.value = list;
}

/**
 * Pick a file and attach it to the selected artifact. Tri-state like attachFile:
 * true = attached, false = the add failed, null = the picker was cancelled.
 */
async function addAttachmentToSelected(): Promise<boolean | null> {
  const artifactId = selectedId.value;
  if (!artifactId) return null;
  try {
    const fileData = await artifactsClient.artifactPickAndReadFile();
    if (!fileData) return null;
    await artifactsClient.artifactAttachmentAdd(artifactId, fileData);
    await loadAttachments();
    return true;
  } catch { return false; }
}

/** Delete one attachment from the selected artifact. Returns true on success. */
async function removeAttachment(attachmentId: string): Promise<boolean> {
  const artifactId = selectedId.value;
  if (!artifactId) return false;
  try {
    const ok = await artifactsClient.artifactAttachmentDelete(artifactId, attachmentId);
    if (ok) await loadAttachments();
    return ok;
  } catch { return false; }
}

/**
 * Subscribe once to artifact IPC events. Safe to call repeatedly.
 *
 * - onArtifactChanged: reload only when it targets the bound session.
 * - onArtifactReveal:  focus that artifact, show the panel, and mark it unread
 *   (green dot). The dot stays until the user explicitly selects/interacts with
 *   it. Other artifacts' unread state is preserved.
 */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;

  eventsClient.onArtifactChanged?.(({ sessionId }) => {
    if (sessionId === activeSessionId) void refresh(sessionId);
  });

  eventsClient.onArtifactReveal?.(async ({ sessionId, artifactId }) => {
    if (sessionId !== activeSessionId) return;
    await refresh(sessionId);
    // Mark only the revealed artifact as unread (it has new/updated content).
    // Preserve existing unread state for all other artifacts.
    const next = new Set(unread.value);
    next.add(artifactId);
    unread.value = next;
    selectedId.value = artifactId;
    selectedVersion.value = null;
    // The reveal swaps the selection after refresh() already loaded the
    // previous artifact's attachments — reload for the revealed one.
    void loadAttachments();
    showPanel();
  });
}

export function useArtifactViewer() {
  return {
    // state
    artifacts,
    selectedId,
    selected,
    selectedVersion,
    panelVisible,
    unread,
    unreadCount,
    attachments,
    // lifecycle
    ensureSubscribed,
    setActiveSession,
    refresh,
    // selection / version
    select,
    setVersion,
    jumpToLatest,
    // panel
    showPanel,
    hidePanel,
    // mutations
    remove,
    clearAll,
    export: exportArtifact,
    openExternal,
    // manual creation
    createTextArtifact,
    createFileArtifact,
    attachFile,
    renameArtifact,
    updateArtifact,
    openAttachment,
    // attachments on the selected artifact
    addAttachmentToSelected,
    removeAttachment,
  };
}
