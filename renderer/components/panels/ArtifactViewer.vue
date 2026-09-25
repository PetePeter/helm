<script setup lang="ts">
/**
 * ArtifactViewer.vue — right-docked master/detail artifact panel.
 *
 * Master: a collapsible index rail (search + sort + Today/Earlier groups,
 * unread dots, hover-delete). Detail: the selected artifact rendered to
 * sanitized HTML with a version bar (‹ › + dropdown + older-version banner).
 * Footer: Edit / Open externally / Export… / Copy reference / Delete. Editing
 * is in-situ over the raw source and saves as a NEW version, so it is offered
 * on the latest version only.
 * Header: title + count + pop-out. Pane close/restore belongs to the dock.
 *
 * Supports manual artifact creation: text notes, file attachments via
 * file picker / drag-and-drop / clipboard paste. Images render inline
 * via helm-img://; binary files show a metadata card with shell-open.
 *
 * The panel is bound to a single session via the `sessionId` prop; the shared
 * useArtifactViewer composable is told which session is active so a snap-out
 * window can render its own instance without cross-talk.
 */
import { computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useArtifactViewer } from '../../composables/useArtifactViewer.js';
import { useToast } from '../../composables/useToast.js';
import { renderArtifact } from '../../artifacts/render-artifact.js';
import { buildArtifactDocument, OPEN_URL_MESSAGE, READY_MESSAGE } from '../../artifacts/build-artifact-document.js';
import { formatHelmRef } from '../../lib/helm-ref.js';
import { artifactsClient, systemClient } from '../../ipc/clients.js';
import { clipboardFileInput } from '../../artifacts/clipboard-file.js';
import { isEditableElement } from '../../input/input-ownership.js';
import { buildTextArtifact, isTextLikeFile, TEXT_INLINE_MAX_BYTES } from '../../artifacts/text-file-drop.js';
import type { Artifact } from '../../../src/types/artifact.js';
import { parseAttachmentHref } from '../../../src/types/artifact-attachment.js';
import Chip from '../common/Chip.vue';
import EmptyState from '../common/EmptyState.vue';
import ListRow from '../common/ListRow.vue';
import PanelHeader from '../common/PanelHeader.vue';
import SearchField from '../common/SearchField.vue';

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{
  (e: 'pop-out'): void;
}>();

const viewer = useArtifactViewer();
const { addToast } = useToast();

// Local rail controls.
import { ref } from 'vue';
type SortMode = 'new' | 'upd' | 'az';
const query = ref('');
const sortMode = ref<SortMode>('new');

const {
  artifacts,
  selectedId,
  selected,
  selectedVersion,
  unread,
  attachments,
} = viewer;

// ── Version helpers ────────────────────────────────────────────────────────

/** The version being shown: pinned selection, else the latest. */
const shownVersion = computed(() => {
  const a = selected.value;
  if (!a || a.versions.length === 0) return null;
  if (selectedVersion.value == null) return a.versions[a.versions.length - 1];
  return a.versions.find(v => v.version === selectedVersion.value)
    ?? a.versions[a.versions.length - 1];
});

const latestVersionNumber = computed(() => {
  const a = selected.value;
  return a && a.versions.length ? a.versions[a.versions.length - 1].version : 0;
});

const isViewingOlder = computed(() =>
  !!shownVersion.value && shownVersion.value.version !== latestVersionNumber.value,
);

/** HTML artifacts render as their own isolated document, not inline. */
const isHtml = computed(() => selected.value?.kind === 'html');

// Markdown only: sanitized inline HTML for v-html. Empty for HTML artifacts,
// which keeps the mermaid watcher below correct without a second condition.
const renderedHtml = computed(() => {
  const a = selected.value;
  const v = shownVersion.value;
  if (!a || !v || isHtml.value) return '';
  return renderArtifact(a.kind, v.content, a.source === 'manual');
});

// ── HTML artifacts: isolated document ───────────────────────────────────────

// Built in the renderer (DOMParser lives here), staged in main, then loaded by
// URL. It must be a real scheme rather than srcdoc: a local-scheme document
// inherits the embedder's CSP, and this window's `script-src 'self'` would
// silently stop the artifact's own scripts from ever running.
const frameSrc = ref('');
const frameRef = ref<HTMLIFrameElement | null>(null);
let frameRequest = 0;

/**
 * A frame that never reports itself ready is a blank panel with nothing to
 * click — the document's own CSP can kill the injected script, and an iframe
 * gives no error event for that. So we wait for the ping and, failing it,
 * surface the escape hatch (open externally) right where the content should be.
 */
const FRAME_READY_TIMEOUT_MS = 1500;
const frameFailed = ref(false);
let readyTimer: ReturnType<typeof setTimeout> | null = null;

function stopReadyWatch(): void {
  if (readyTimer !== null) clearTimeout(readyTimer);
  readyTimer = null;
}

function startReadyWatch(): void {
  stopReadyWatch();
  frameFailed.value = false;
  readyTimer = setTimeout(() => { frameFailed.value = true; }, FRAME_READY_TIMEOUT_MS);
}

watch(() => {
  const artifact = selected.value;
  const version = shownVersion.value;
  if (!artifact || artifact.kind !== 'html' || !version) return null;
  // Refresh replaces artifact/version objects even when the selected document
  // is unchanged. Watch stable content identity so a background list refresh
  // does not reload an interactive frame or reset its scroll position.
  return [artifact.id, version.version, version.content] as const;
}, async (documentIdentity) => {
  const request = ++frameRequest;
  if (!documentIdentity) {
    stopReadyWatch();
    frameFailed.value = false;
    frameSrc.value = '';
    return;
  }
  const doc = buildArtifactDocument(documentIdentity[2]);
  const nonce = await artifactsClient.artifactPrepareRender(doc);
  if (request !== frameRequest) return;
  frameSrc.value = `helm-artifact://doc/?k=${encodeURIComponent(nonce)}`;
  startReadyWatch();
}, { immediate: true });

/**
 * Links inside the frame are inert (sandbox blocks navigation, CSP blocks
 * loads), so the frame reports clicks here instead — same external-open
 * behaviour as the markdown path.
 *
 * The frame has an opaque origin, so `event.origin` is the string "null" and is
 * useless as a gate; identity of the sending window is the real check.
 */
function onFrameMessage(e: MessageEvent): void {
  if (e.source !== frameRef.value?.contentWindow) return;
  const data = e.data as { type?: string; url?: string } | null;
  if (data?.type === READY_MESSAGE) {
    stopReadyWatch();
    frameFailed.value = false;
    return;
  }
  if (data?.type !== OPEN_URL_MESSAGE) return;
  const url = data.url ?? '';
  if (/^https?:\/\//i.test(url)) void systemClient.systemOpenExternalUrl(url);
}

// ── Mermaid diagrams ────────────────────────────────────────────────────────
const docRef = ref<HTMLElement | null>(null);
let mermaidReady = false;

async function renderMermaid(): Promise<void> {
  const root = docRef.value;
  if (!root) return;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])'));
  if (nodes.length === 0) return;
  try {
    const mermaid = (await import('mermaid')).default;
    if (!mermaidReady) {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      mermaidReady = true;
    }
    await mermaid.run({ nodes });
  } catch (err) {
    console.error('[ArtifactViewer] mermaid render failed', err);
  } finally {
    markUnrenderedMermaid(nodes);
  }
}

/**
 * mermaid.run() suppresses parse errors by default (leaves the raw source and
 * moves on), so a broken diagram looked like styled code with no explanation.
 * Any node that still has no SVG gets a visible one-line failure note instead.
 */
function markUnrenderedMermaid(nodes: HTMLElement[]): void {
  for (const node of nodes) {
    if (node.querySelector('svg') || node.querySelector('.mermaid-fail-note')) continue;
    node.classList.add('mermaid-failed');
    const note = document.createElement('div');
    note.className = 'mermaid-fail-note';
    note.textContent = '⚠ Diagram could not be rendered — see source above';
    node.append(note);
  }
}

watch(renderedHtml, () => { void nextTick(renderMermaid); });

function stepVersion(delta: number): void {
  const a = selected.value;
  if (!a) return;
  const current = shownVersion.value?.version ?? latestVersionNumber.value;
  const idx = a.versions.findIndex(v => v.version === current);
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= a.versions.length) return;
  viewer.setVersion(a.versions[nextIdx].version);
}

// ── Rail list (filter → sort → group) ──────────────────────────────────────

function matches(a: Artifact, q: string): boolean {
  if (!q) return true;
  return a.title.toLowerCase().includes(q) || a.kind.includes(q);
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const rows = artifacts.value.filter(a => matches(a, q));
  const sorted = [...rows];
  if (sortMode.value === 'az') {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortMode.value === 'new') {
    sorted.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
});

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface RailRow { kind: 'header' | 'item'; label?: string; artifact?: Artifact }

const railRows = computed<RailRow[]>(() => {
  const rows: RailRow[] = [];
  const today = startOfToday();
  let lastGroup: string | null = null;
  const grouped = sortMode.value !== 'az';
  for (const a of filtered.value) {
    if (grouped) {
      const group = a.updatedAt >= today ? 'Today' : 'Earlier';
      if (group !== lastGroup) {
        lastGroup = group;
        rows.push({ kind: 'header', label: group });
      }
    }
    rows.push({ kind: 'item', artifact: a });
  }
  return rows;
});

function relativeTime(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Kind badge label: IMG for image-based markdown, BIN for binary, otherwise MD/HTML. */
function kindLabel(a: Artifact): string {
  if (a.source === 'manual') {
    const content = a.versions[a.versions.length - 1]?.content ?? '';
    if (content.startsWith('![')) return 'IMG';
    if (content.includes('Open in system viewer')) return 'BIN';
  }
  return a.kind === 'markdown' ? 'MD' : 'HTML';
}

function kindTone(a: Artifact): 'accent' | 'info' | 'warning' {
  const kind = kindLabel(a);
  if (kind === 'MD') return 'accent';
  if (kind === 'BIN') return 'warning';
  return 'info';
}

const count = computed(() => artifacts.value.length);

// ── Actions ────────────────────────────────────────────────────────────────

function onSelect(id: string): void { viewer.select(id); }
function onExport(): void { if (selectedId.value) void viewer.export(selectedId.value); }

// Opens the version currently on screen (Export, by contrast, always writes the
// latest). The failure reason is shown inline rather than swallowed — some
// systems have no application registered for .md.
const openError = ref<string | null>(null);
async function onOpenExternal(): Promise<void> {
  const id = selectedId.value;
  if (!id) return;
  openError.value = null;
  const result = await viewer.openExternal(id, shownVersion.value?.version);
  if (!result.success) openError.value = result.error ?? 'Could not open externally';
}

// Footer delete is guarded by an inline confirm so it can't be a one-click accident.
const confirmDelete = ref(false);
function onConfirmDelete(): void {
  const id = selectedId.value;
  confirmDelete.value = false;
  if (id) void viewer.remove(id);
}
watch(selectedId, () => {
  confirmDelete.value = false;
  openError.value = null;
  isEditing.value = false;
  isRenaming.value = false;
});

async function onCopyRef(): Promise<void> {
  const a = selected.value;
  if (!a) return;
  try {
    await navigator.clipboard.writeText(formatHelmRef('artifact', { label: a.title, id: a.id }));
    addToast({ message: 'Reference copied', type: 'success' });
  } catch {
    addToast({ message: 'Copy failed', type: 'error' });
  }
}

/**
 * Intercept clicks on links inside the rendered artifact. The content is
 * AI-authored (untrusted) and lives in the privileged window, so we never
 * let a link navigate the app itself.
 */
function onDocClick(e: MouseEvent): void {
  const anchor = (e.target as HTMLElement | null)?.closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href') ?? '';

  // Attachment links are app-internal ids, not URLs — open the stored file.
  const attachment = parseAttachmentHref(href);
  if (attachment) {
    void openAttachmentLink(attachment.artifactId, attachment.attachmentId);
    return;
  }

  if (/^https?:\/\//i.test(href)) void systemClient.systemOpenExternalUrl(href);
}

async function openAttachmentLink(artifactId: string, attachmentId: string): Promise<void> {
  if (!await viewer.openAttachment(artifactId, attachmentId)) {
    addToast({ message: 'Could not open the attached file', type: 'error' });
  }
}

// ── Attachments on the selected artifact ────────────────────────────────────

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}

const attachmentBusyId = ref<string | null>(null);

async function onAddAttachment(): Promise<void> {
  if (!selectedId.value) return;
  attachmentBusyId.value = null;
  const result = await viewer.addAttachmentToSelected();
  // A cancelled picker is quiet; only a failed add is worth a toast.
  if (result === false) addToast({ message: 'Could not attach file (max 10 MB)', type: 'error' });
}

async function onOpenAttachment(attachmentId: string): Promise<void> {
  if (!selectedId.value) return;
  attachmentBusyId.value = attachmentId;
  try {
    if (!await viewer.openAttachment(selectedId.value, attachmentId)) {
      addToast({ message: 'Could not open attachment', type: 'error' });
    }
  } finally {
    attachmentBusyId.value = null;
  }
}

async function onDeleteAttachment(attachmentId: string): Promise<void> {
  attachmentBusyId.value = attachmentId;
  try {
    if (!await viewer.removeAttachment(attachmentId)) {
      addToast({ message: 'Could not delete attachment', type: 'error' });
    }
  } finally {
    attachmentBusyId.value = null;
  }
}

// ── Manual creation: New button + dropdown ─────────────────────────────────

const showCreateMenu = ref(false);

function onCreateTextNote(): void {
  showCreateMenu.value = false;
  isCreatingText.value = true;
  newTextTitle.value = '';
  newTextContent.value = '';
}

async function onCreateFromClipboard(): Promise<void> {
  showCreateMenu.value = false;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      // Prefer a file-like representation when a clipboard item has both an
      // image/binary type and text/plain (common for copied screenshots).
      const fileType = item.types.find(type => type !== 'text/plain');
      if (fileType) {
        await createArtifactFromBlob(await item.getType(fileType));
        return;
      }
      if (!item.types.includes('text/plain')) continue;
      const text = await (await item.getType('text/plain')).text();
      if (text.trim()) {
        isCreatingText.value = true;
        newTextTitle.value = 'Pasted note';
        newTextContent.value = text;
      }
      return;
    }
    addToast({ message: 'No supported clipboard item', type: 'error' });
  } catch {
    addToast({ message: 'Could not read clipboard', type: 'error' });
  }
}

// ── Manual creation: text note editor ──────────────────────────────────────

const isCreatingText = ref(false);
const newTextTitle = ref('');
const newTextContent = ref('');

async function onSaveTextNote(): Promise<void> {
  const title = newTextTitle.value.trim() || 'Untitled note';
  const content = newTextContent.value;
  if (!content.trim()) return;
  const artifact = await viewer.createTextArtifact(title, content);
  if (artifact) {
    isCreatingText.value = false;
    newTextTitle.value = '';
    newTextContent.value = '';
    addToast({ message: 'Note created', type: 'success' });
  } else {
    addToast({ message: 'Failed to create note', type: 'error' });
  }
}

function onCancelTextNote(): void {
  isCreatingText.value = false;
  newTextTitle.value = '';
  newTextContent.value = '';
}

// ── Manual creation: file attach (file picker) ──────────────────────────────

async function onAttachFile(): Promise<void> {
  const artifact = await viewer.attachFile();
  if (artifact) {
    addToast({ message: 'File attached', type: 'success' });
  } else if (artifact === null) {
    // User cancelled the dialog — no toast needed
  } else {
    addToast({ message: 'Failed to attach file', type: 'error' });
  }
}

// ── Manual creation: paste handler (clipboard files and binary) ────────────

async function handlePaste(e: ClipboardEvent): Promise<void> {
  // Let editable controls keep their native paste behaviour.
  if (isCreatingText.value || isEditableElement(e.target)) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  // Files first: a copied screenshot carries both an image and a text/plain
  // fallback, and the image is the one worth keeping.
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    e.preventDefault();
    e.stopPropagation();
    void createArtifactFromBlob(file, file.name);
    return;
  }

  // Pasting into the artifact pane means "make this an artifact", so text lands
  // in the note editor rather than doing nothing.
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text.trim()) return;
  e.preventDefault();
  e.stopPropagation();
  isCreatingText.value = true;
  newTextTitle.value = 'Pasted note';
  newTextContent.value = text;
}

/**
 * The single entry point for turning a file into an artifact — shared by paste,
 * drag-drop and the file picker so all three behave identically. Returns false
 * when nothing was created; the caller owns the toast.
 *
 * A readable file becomes readable CONTENT. Identification is by extension
 * (Chromium reports an empty blob.type for .md and most source files), so
 * dropping notes.md gives you the document, not a binary metadata card.
 */
async function addBlobAsArtifact(blob: Blob, filename?: string): Promise<boolean> {
  const name = filename ?? '';
  if (blob.size <= TEXT_INLINE_MAX_BYTES && isTextLikeFile(name, blob.type)) {
    const draft = buildTextArtifact(name, await blob.text());
    return Boolean(await viewer.createTextArtifact(draft.title, draft.content));
  }
  return Boolean(await viewer.createFileArtifact(await clipboardFileInput(blob, filename)));
}

async function createArtifactFromBlob(blob: Blob, filename?: string): Promise<void> {
  try {
    const created = await addBlobAsArtifact(blob, filename);
    addToast(created
      ? { message: blob.type.startsWith('image/') ? 'Image pasted' : 'File added', type: 'success' }
      : { message: 'Failed to add file', type: 'error' });
  } catch {
    addToast({ message: 'Failed to process file', type: 'error' });
  }
}

// ── Manual creation: drag-and-drop ────────────────────────────────────────

const isDragOver = ref(false);

function onDragOver(e: DragEvent): void {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    isDragOver.value = true;
  }
}

function onDragLeave(): void {
  isDragOver.value = false;
}

async function onDrop(e: DragEvent): Promise<void> {
  isDragOver.value = false;
  // Only file drops belong to the artifact panel. Any other drag — a session
  // card, a dock pane — must pass through untouched, so the panel never claims
  // a drop it cannot handle.
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await addBlobAsArtifact(file, file.name);
    } catch {
      addToast({ message: `Failed to drop ${file.name}`, type: 'error' });
    }
  }
  if (files.length === 1) {
    addToast({ message: 'File added', type: 'success' });
  } else {
    addToast({ message: `${files.length} files added`, type: 'success' });
  }
}

// ── Inline title rename ────────────────────────────────────────────────────

const isRenaming = ref(false);
const renameTitle = ref('');

function onStartRename(): void {
  if (!selected.value) return;
  renameTitle.value = selected.value.title;
  isRenaming.value = true;
}

async function onCommitRename(): Promise<void> {
  const trimmed = renameTitle.value.trim();
  if (!trimmed || !selectedId.value) {
    isRenaming.value = false;
    return;
  }
  const success = await viewer.renameArtifact(selectedId.value, trimmed);
  isRenaming.value = false;
  if (!success) addToast({ message: 'Rename failed', type: 'error' });
}

// ── In-situ content edit ───────────────────────────────────────────────────

// Editing appends a version rather than rewriting one, so only the latest can
// be edited — otherwise "edit v2 of 5" would silently produce v6.
const isEditing = ref(false);
const editContent = ref('');
const canEdit = computed(() => Boolean(selected.value) && !isViewingOlder.value);

function onStartEdit(): void {
  const version = shownVersion.value;
  if (!version || !canEdit.value) return;
  editContent.value = version.content;
  isEditing.value = true;
}

async function onSaveEdit(): Promise<void> {
  const id = selectedId.value;
  if (!id || !editContent.value.trim()) return;
  if (!await viewer.updateArtifact(id, editContent.value)) {
    addToast({ message: 'Save failed', type: 'error' });
    return;
  }
  isEditing.value = false;
  editContent.value = '';
  addToast({ message: 'Saved as a new version', type: 'success' });
}

function onCancelEdit(): void {
  isEditing.value = false;
  editContent.value = '';
}

// ── Session binding / lifecycle ────────────────────────────────────────────

onMounted(() => {
  viewer.ensureSubscribed();
  void viewer.setActiveSession(props.sessionId);
  void nextTick(renderMermaid);
  window.addEventListener('message', onFrameMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage);
  stopReadyWatch();
});

watch(() => props.sessionId, (id) => { void viewer.setActiveSession(id); });
</script>

<template>
  <div class="artifact-panel" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop" @paste="handlePaste">
    <!-- Drop overlay -->
    <div v-if="isDragOver" class="ap-drop-overlay">
      <span class="ap-drop-icon">📎</span>
      <span class="ap-drop-label">Drop file to create artifact</span>
      <span class="ap-drop-sub">Images, documents, or any file</span>
    </div>

    <PanelHeader title="Artifacts" :subtitle="`${count} · session-scoped`" icon="📄">
      <template #actions>
        <button class="ap-ico" title="Pop out with terminal" @click="emit('pop-out')">⧉</button>
      </template>
      <template #toolbar>
        <SearchField
          v-model="query"
          class="ap-search"
          placeholder="Search artifacts…"
          aria-label="Search artifacts"
        />
      </template>
    </PanelHeader>

    <div class="ap-main">
      <!-- MASTER: index rail -->
      <div class="ap-rail">
        <div class="ap-rail-inner">
          <div class="ap-rail-tools">
            <div class="ap-new-row">
              <div class="ap-create-dropdown">
                <button class="ap-btn-new" @click="showCreateMenu = !showCreateMenu">+ New ▾</button>
                <div v-if="showCreateMenu" class="dropdown-menu">
                  <button class="dropdown-item" @click="onCreateTextNote">📝 Text note</button>
                  <button class="dropdown-item" @click="onCreateFromClipboard">📋 Paste from clipboard</button>
                </div>
              </div>
              <button class="ap-btn-attach" title="Pick a file to attach" @click="onAttachFile">📎</button>
            </div>
            <div class="ap-sort">
              <span>Sort</span>
              <select v-model="sortMode">
                <option value="new">Newest</option>
                <option value="upd">Recently updated</option>
                <option value="az">A–Z</option>
              </select>
            </div>
          </div>
          <div class="ap-rail-list">
            <EmptyState v-if="artifacts.length === 0" class="ap-empty" title="No artifacts yet." />
            <EmptyState v-else-if="railRows.length === 0" class="ap-empty" title="No artifacts match your search." />
            <template v-for="(row, i) in railRows" :key="row.kind === 'header' ? 'h-' + row.label + i : row.artifact!.id">
              <div v-if="row.kind === 'header'" class="ap-grp-h">{{ row.label }}</div>
              <ListRow
                v-else
                class="ap-item"
                :class="{ 'ap-item--active': row.artifact!.id === selectedId, 'ap-item--unread': unread.has(row.artifact!.id) }"
                :selected="row.artifact!.id === selectedId"
                :unread="unread.has(row.artifact!.id)"
                @click="onSelect(row.artifact!.id)"
              >
                <template #title>
                  <span class="ap-dot" aria-hidden="true"></span>
                  <span class="ap-it-title">{{ row.artifact!.title }}</span>
                </template>
                <template #meta>
                  <span class="ap-it-meta">
                    <Chip class="ap-kind" :label="kindLabel(row.artifact!)" :tone="kindTone(row.artifact!)" />
                    <span v-if="row.artifact!.source === 'manual'" class="ap-src">manual</span>
                    <span class="ap-vcount">v{{ row.artifact!.versions.length }}</span>
                    <span>{{ relativeTime(row.artifact!.updatedAt) }}</span>
                  </span>
                </template>
              </ListRow>
            </template>
          </div>
        </div>
      </div>

      <!-- DETAIL -->
      <div class="ap-detail">
        <!-- Text note creation editor -->
        <template v-if="isCreatingText">
          <div class="ap-v-bar">
            <input
              v-model="newTextTitle"
              class="ap-create-title-input"
              placeholder="Note title…"
              autofocus
              @keydown.enter="onSaveTextNote"
              @keydown.escape="onCancelTextNote"
            />
            <span class="ap-v-spacer"></span>
            <button class="ap-btn" @click="onCancelTextNote">Cancel</button>
            <button class="ap-btn ap-btn--primary" :disabled="!newTextContent.trim()" @click="onSaveTextNote">💾 Save</button>
          </div>
          <textarea
            v-model="newTextContent"
            class="ap-create-body"
            placeholder="Write your note here…&#10;&#10;Supports **markdown** formatting."
            autofocus
          ></textarea>
        </template>

        <!-- Artifact view -->
        <template v-else-if="selected">
          <div class="ap-v-bar">
            <input
              v-if="isRenaming"
              v-model="renameTitle"
              class="ap-rename-input"
              @blur="onCommitRename"
              @keydown.enter="onCommitRename"
              @keydown.escape="isRenaming = false"
              autofocus
            />
            <template v-else>
              <span class="ap-d-name ap-d-name--renameable" title="Double-click to rename" @dblclick="onStartRename">{{ selected.title }}</span>
              <button class="ap-v-step ap-rename-btn" title="Rename" @click="onStartRename">✎</button>
            </template>
            <span class="ap-v-spacer"></span>
            <button class="ap-v-step" title="Older" @click="stepVersion(-1)">‹</button>
            <label class="ap-v-sel" title="Version">
              <select
                :value="shownVersion ? shownVersion.version : latestVersionNumber"
                @change="viewer.setVersion(Number(($event.target as HTMLSelectElement).value))"
              >
                <option v-for="v in selected.versions" :key="v.version" :value="v.version">
                  v{{ v.version }} of {{ selected.versions.length }}
                </option>
              </select>
            </label>
            <button class="ap-v-step" title="Newer" @click="stepVersion(1)">›</button>
          </div>

          <div v-if="isViewingOlder" class="ap-v-old">
            <span>👁 Viewing v{{ shownVersion!.version }} — not the latest.</span>
            <button class="ap-restore" @click="viewer.jumpToLatest()">Jump to latest ›</button>
          </div>

          <div class="ap-body" :class="{ 'ap-body--frame': isHtml && !isEditing, 'ap-body--edit': isEditing }">
            <!-- In-situ edit: raw source of the shown version; Save appends a version. -->
            <textarea
              v-if="isEditing"
              v-model="editContent"
              class="ap-create-body"
              aria-label="Artifact content"
              @keydown.escape="onCancelEdit"
            ></textarea>

            <!-- HTML artifacts: opaque-origin document, sandboxed on top. Scripts
                 run but cannot reach the app DOM, the preload bridge, or the network. -->
            <template v-else-if="isHtml">
              <iframe
                ref="frameRef"
                class="ap-frame"
                :src="frameSrc"
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
              ></iframe>
              <!-- The frame never reported itself ready, so it is showing nothing.
                   Put the escape hatch where the content should have been. -->
              <div v-if="frameFailed" class="ap-frame-fallback">
                <div class="ap-ff-card">
                  <span class="ap-ff-icon" aria-hidden="true">⧉</span>
                  <p class="ap-ff-title">This document can't be displayed here</p>
                  <p class="ap-ff-sub">Open it in your default app to see the full version.</p>
                  <button class="ap-btn ap-btn--primary ap-ff-btn" @click="onOpenExternal">⧉ Open externally</button>
                </div>
              </div>
            </template>

            <div v-else class="ap-doc" ref="docRef" v-html="renderedHtml" @click="onDocClick"></div>
          </div>

          <!-- Attachments: a side store on the artifact; the body keeps its own links. -->
          <div v-if="!isEditing" class="ap-att">
            <div class="ap-att__head">
              <span class="ap-att__title">Attachments ({{ attachments.length }})</span>
              <button class="ap-btn ap-att__add" title="Attach a file to this artifact" @click="onAddAttachment">📎 Add</button>
            </div>
            <div v-if="attachments.length === 0" class="ap-att__empty">No attachments</div>
            <div v-else class="ap-att__list">
              <div v-for="att in attachments" :key="att.id" class="ap-att__row">
                <span class="ap-att__name" :title="att.filename">{{ att.filename }}</span>
                <span class="ap-att__size">{{ formatAttachmentSize(att.sizeBytes) }}</span>
                <button class="ap-btn" :disabled="attachmentBusyId === att.id" @click="onOpenAttachment(att.id)">Open</button>
                <button class="ap-btn ap-btn--danger" :disabled="attachmentBusyId === att.id" @click="onDeleteAttachment(att.id)">Delete</button>
              </div>
            </div>
          </div>
        </template>

        <!-- Empty state -->
        <div v-else class="ap-detail-empty">
          <p>No artifact selected.</p>
          <p class="ap-detail-empty-sub">
            Create notes, paste content, or drag files here.<br>
            AI-authored artifacts also appear here.
          </p>
          <button class="ap-btn ap-btn--primary" @click="showCreateMenu = true">+ New artifact</button>
        </div>

        <!-- Footer -->
        <div v-if="isEditing" class="ap-foot">
          <span class="ap-foot-note">Saving adds a new version — earlier ones are kept.</span>
          <span class="ap-grow"></span>
          <button class="ap-btn" @click="onCancelEdit">Cancel</button>
          <button class="ap-btn ap-btn--primary" :disabled="!editContent.trim()" @click="onSaveEdit">💾 Save</button>
        </div>
        <div v-else-if="!isCreatingText" class="ap-foot">
          <button
            class="ap-btn"
            :title="canEdit ? 'Edit content — saves as a new version' : 'Jump to the latest version to edit'"
            :disabled="!canEdit"
            @click="onStartEdit"
          >✎ Edit</button>
          <button class="ap-btn" title="Open this version in your default app" :disabled="!selected" @click="onOpenExternal">⧉ Open externally</button>
          <button class="ap-btn" title="Save to a location you pick" :disabled="!selected" @click="onExport">⭳ Export…</button>
          <button class="ap-btn" title="Copy a reference an AI can resolve" :disabled="!selected" @click="onCopyRef">📋 Copy reference</button>
          <span v-if="openError" class="ap-foot-error">{{ openError }}</span>
          <span class="ap-grow"></span>
          <template v-if="confirmDelete">
            <span class="ap-foot-confirm">Delete?</span>
            <button class="ap-btn ap-btn--danger" title="Confirm delete" @click="onConfirmDelete">✓ Yes</button>
            <button class="ap-btn" title="Cancel" @click="confirmDelete = false">✕</button>
          </template>
          <button v-else class="ap-btn ap-btn--danger" title="Delete this artifact" :disabled="!selected" @click="confirmDelete = true">🗑 Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.artifact-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border);
  min-width: 0;
  overflow: hidden;
  position: relative;
}

/* header */
.ap-ico { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-sm); border: 1px solid transparent; color: var(--text-secondary); font-size: var(--font-size-lg); }
.ap-ico:hover { border-color: var(--border); color: var(--text-primary); background: var(--bg-tertiary); }
.ap-ico:focus-visible,
.ap-btn-new:focus-visible,
.ap-btn-attach:focus-visible,
.dropdown-item:focus-visible,
.ap-v-step:focus-visible,
.ap-restore:focus-visible,
.ap-btn:focus-visible,
.ap-sort select:focus-visible,
.ap-v-sel select:focus-visible,
.ap-create-title-input:focus-visible,
.ap-create-body:focus-visible,
.ap-rename-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ap-main { flex: 1; display: flex; min-height: 0; }

/* index rail */
.ap-rail { width: 214px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg-secondary); }
.ap-rail-inner { flex: 1; display: flex; flex-direction: column; min-height: 0; }

.ap-rail-tools { padding: var(--spacing-sm); display: flex; flex-direction: column; gap: var(--spacing-xs); border-bottom: 1px solid var(--border); }

/* New + Attach row */
.ap-new-row { display: flex; gap: var(--spacing-xs); }
.ap-btn-new { flex: 1; font-size: var(--font-size-sm); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); border: 1px solid var(--accent); background: rgba(79,208,139,0.12); color: var(--accent); cursor: pointer; font-weight: 600; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: var(--spacing-xs); }
.ap-btn-new:hover { background: rgba(79,208,139,0.22); }
.ap-btn-attach { font-size: var(--font-size-sm); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-tertiary); color: var(--text-primary); cursor: pointer; font-family: inherit; }
.ap-btn-attach:hover { border-color: var(--accent); color: var(--accent); }

/* Create dropdown */
.ap-create-dropdown { position: relative; }
.dropdown-menu { position: absolute; top: 100%; left: 0; right: 0; z-index: 50; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-md); margin-top: var(--spacing-xs); padding: var(--spacing-xs); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
.dropdown-item { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); font-size: var(--font-size-sm); color: var(--text-primary); cursor: pointer; border: none; background: none; width: 100%; text-align: left; font-family: inherit; }
.dropdown-item:hover { background: rgba(79,208,139,0.12); color: var(--accent); }

.ap-search { width: 100%; }
.ap-sort { display: flex; align-items: center; gap: var(--spacing-xs); font-size: var(--font-size-xs); color: var(--text-secondary); }
.ap-sort select { flex: 1; background: var(--bg-primary); color: var(--text-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); font-size: var(--font-size-xs); font-family: inherit; }
.ap-sort select option { background: var(--bg-secondary); color: var(--text-primary); }

.ap-rail-list { flex: 1; overflow-y: auto; padding: var(--spacing-xs) var(--spacing-sm) var(--spacing-sm); }
.ap-grp-h { font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); padding: var(--spacing-sm) var(--spacing-sm) var(--spacing-xs); position: sticky; top: 0; background: var(--bg-secondary); }
.ap-item { margin-bottom: var(--spacing-xs); }
.ap-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin: 0 var(--spacing-sm) 0 0; background: transparent; }
.ap-item--unread .ap-dot { background: var(--accent); }
.ap-it-title { color: var(--text-primary); }
.ap-it-meta { display: inline-flex; gap: var(--spacing-sm); align-items: center; margin-top: 0; }
.ap-vcount { color: var(--text-dim); }
.ap-src { color: var(--text-dim); font-style: italic; }

/* detail */
.ap-detail { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg-primary); }
.ap-v-bar { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
.ap-d-name { font-size: var(--font-size-sm); font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap-d-name--renameable:hover { color: var(--accent); cursor: text; }
.ap-v-spacer { flex: 1; }
.ap-v-step { width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border); color: var(--text-secondary); font-size: var(--font-size-sm); }
.ap-v-step:hover { border-color: var(--accent); color: var(--accent); }
.ap-v-sel { display: flex; align-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); }
.ap-v-sel select { background: none; border: none; outline: none; color: var(--text-primary); font-size: var(--font-size-sm); padding: var(--spacing-xs) var(--spacing-sm); font-family: inherit; }
.ap-v-sel select option { background: var(--bg-secondary); color: var(--text-primary); }

.ap-v-old { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) var(--spacing-md); background: color-mix(in srgb, var(--info) 9%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--info) 35%, var(--border)); font-size: var(--font-size-sm); color: var(--info); }
.ap-restore { margin-left: auto; font-size: var(--font-size-xs); color: var(--accent); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); background: none; }

.ap-body { flex: 1; overflow: auto; padding: var(--spacing-md); }
/* HTML artifacts own their whole viewport and scroll inside the frame. */
.ap-body--frame { overflow: hidden; padding: 0; }
.ap-body--frame { position: relative; }
/* in-situ editor fills the body, like the creation editor does */
.ap-body--edit { overflow: hidden; padding: 0; display: flex; }
.ap-frame { width: 100%; height: 100%; border: 0; display: block; background: var(--bg-primary); }

/* Shown only when the frame never reported itself ready — see startReadyWatch. */
.ap-frame-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: var(--spacing-lg); background: var(--bg-primary);
}
.ap-ff-card {
  display: flex; flex-direction: column; align-items: center; gap: var(--spacing-sm); text-align: center;
  max-width: 320px; padding: var(--spacing-lg);
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary);
}
.ap-ff-icon { font-size: var(--font-size-2xl); color: var(--accent); }
.ap-ff-title { margin: 0; font-size: var(--font-size-md); color: var(--text-primary); }
.ap-ff-sub { margin: 0; font-size: var(--font-size-sm); color: var(--text-dim); line-height: 1.5; }
.ap-ff-btn { margin-top: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); font-size: var(--font-size-sm); }
.ap-detail-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--spacing-sm); }
.ap-detail-empty-sub { color: var(--text-dim); font-size: var(--font-size-sm); text-align: center; line-height: 1.5; }

/* text creation editor */
.ap-create-title-input { flex: 1; min-width: 0; background: var(--bg-primary); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); color: var(--text-primary); font-size: var(--font-size-sm); font-family: inherit; outline: none; box-shadow: 0 0 0 3px var(--focus); }
.ap-create-body { flex: 1; background: var(--bg-secondary); border: none; border-top: 1px solid var(--border); padding: var(--spacing-md); color: var(--text-primary); font-size: var(--font-size-sm); font-family: inherit; outline: none; resize: none; line-height: 1.6; }
.ap-create-body:focus { box-shadow: inset 0 0 0 2px rgba(79,208,139,0.1); }

/* rename input */
.ap-rename-input { flex: 1; min-width: 0; background: var(--bg-primary); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: var(--spacing-xs); color: var(--text-primary); font-size: var(--font-size-sm); font-family: inherit; outline: none; box-shadow: 0 0 0 3px var(--focus); }

/* drop overlay */
.ap-drop-overlay { position: absolute; inset: 0; z-index: 40; background: rgba(79,208,139,0.08); border: 2px dashed var(--accent); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--spacing-sm); pointer-events: none; }
.ap-drop-icon { font-size: var(--font-size-2xl); }
.ap-drop-label { font-size: var(--font-size-md); color: var(--accent); font-weight: 600; }
.ap-drop-sub { font-size: var(--font-size-sm); color: var(--text-secondary); }

/* rendered document */
.ap-doc :deep(h1), .ap-doc :deep(h2) { font-size: var(--font-size-xl); margin: 0 0 var(--spacing-sm); border-bottom: 1px solid var(--border); padding-bottom: var(--spacing-xs); }
.ap-doc :deep(h3) { font-size: var(--font-size-md); margin: var(--spacing-md) 0 var(--spacing-xs); color: var(--accent); }
.ap-doc :deep(p) { font-size: var(--font-size-sm); line-height: 1.6; color: var(--text-primary); margin: var(--spacing-xs) 0; }
.ap-doc :deep(ul), .ap-doc :deep(ol) { margin: var(--spacing-xs) 0; padding-left: var(--spacing-md); }
.ap-doc :deep(li) { font-size: var(--font-size-sm); line-height: 1.55; color: var(--text-primary); margin: var(--spacing-xs) 0; }
.ap-doc :deep(code) { background: var(--bg-tertiary); padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); font-family: Consolas, monospace; font-size: var(--font-size-sm); color: var(--accent); }
.ap-doc :deep(pre) { background: var(--bg-tertiary); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); overflow: auto; }
.ap-doc :deep(pre code) { background: none; padding: 0; }
.ap-doc :deep(pre.mermaid) { background: transparent; padding: var(--spacing-sm) 0; text-align: center; overflow-x: auto; }
.ap-doc :deep(pre.mermaid svg) { max-width: 100%; height: auto; }
.ap-doc :deep(pre.mermaid-failed) { border: 1px dashed var(--danger-border); border-radius: var(--radius-sm); padding: var(--spacing-sm); text-align: left; }
.ap-doc :deep(.mermaid-fail-note) { font-size: var(--font-size-xs); color: var(--danger); margin-top: var(--spacing-xs); }
.ap-doc :deep(table) { border-collapse: collapse; width: 100%; margin: var(--spacing-sm) 0; font-size: var(--font-size-sm); }
.ap-doc :deep(th), .ap-doc :deep(td) { border: 1px solid var(--border); padding: var(--spacing-xs) var(--spacing-sm); text-align: left; }
.ap-doc :deep(th) { background: var(--bg-tertiary); color: var(--text-secondary); }
.ap-doc :deep(a) { color: var(--info); }
.ap-doc :deep(a:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.ap-doc :deep(img) { max-width: 100%; border-radius: var(--radius-md); border: 1px solid var(--border); }

/* attachments on the selected artifact */
.ap-att { border-top: 1px solid var(--border); background: var(--bg-secondary); padding: var(--spacing-sm) var(--spacing-md); display: flex; flex-direction: column; gap: var(--spacing-xs); }
.ap-att__head { display: flex; align-items: center; gap: var(--spacing-sm); }
.ap-att__title { font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); }
.ap-att__add { padding: var(--spacing-xs) var(--spacing-sm); }
.ap-att__empty { font-size: var(--font-size-sm); color: var(--text-dim); }
.ap-att__list { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.ap-att__row { display: flex; align-items: center; gap: var(--spacing-sm); }
.ap-att__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); color: var(--text-primary); }
.ap-att__size { font-size: var(--font-size-xs); color: var(--text-dim); flex-shrink: 0; }
.ap-att__row .ap-btn { padding: var(--spacing-xs) var(--spacing-sm); }

/* footer */
.ap-foot { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-top: 1px solid var(--border); }
.ap-btn { font-size: var(--font-size-sm); padding: var(--spacing-xs) var(--spacing-md); border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-tertiary); color: var(--text-primary); display: inline-flex; gap: var(--spacing-xs); align-items: center; }
.ap-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ap-btn:disabled { opacity: 0.4; cursor: default; }
.ap-btn--primary { border-color: var(--accent); background: rgba(79,208,139,0.12); color: var(--accent); font-weight: 600; }
.ap-btn--primary:hover:not(:disabled) { background: rgba(79,208,139,0.22); }
.ap-btn--danger:hover:not(:disabled) { border-color: var(--danger-border); color: var(--danger); }
.ap-btn { cursor: pointer; font-family: inherit; }
.ap-foot-confirm { font-size: var(--font-size-sm); color: var(--text-primary); }
.ap-foot-error { font-size: var(--font-size-sm); color: var(--danger); }
.ap-foot-note { font-size: var(--font-size-sm); color: var(--text-dim); }
.ap-rename-btn { font-size: var(--font-size-sm); }
.ap-grow { flex: 1; }
</style>
