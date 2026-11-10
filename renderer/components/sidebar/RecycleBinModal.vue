<script setup lang="ts">
/**
 * RecycleBinModal.vue — restore or forget closed, recoverable sessions.
 *
 * Sessions closed while carrying a cliSessionName land here (30-day window).
 * Entries render as a nested, collapsible, searchable tree:
 *   Project ▸ Runtime Group ▸ Folder ▸ sessions
 * Ungrouped folders sit at the project's child level (no group wrapper). Every
 * level folds independently and shows a live descendant count. A search box
 * filters across name / CLI / path and hides emptied levels. Nodes start
 * collapsed and their fold state is remembered between visits.
 *
 * Restore re-spawns via the normal spawn-with-resume flow; Forget deletes a
 * single entry; per-folder bulk actions loop those same IPC calls; Empty clears
 * the bin behind a confirmation, since it also destroys every entry's artifacts.
 * Retention/expiry lives in the manager — it is intentionally NOT surfaced here.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { RecycleBinEntry } from '../../../src/types/recycle-bin.js';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useRecycleBin } from '../../composables/useRecycleBin.js';
import { state } from '../../state.js';
import { getCliDisplayName } from '../../utils.js';
import {
  buildRecycleTree,
  type RecycleFolderNode,
  type ResolveProject,
} from '../../recycle-bin-tree.js';
import { useTreeExpansion, type TreeNodeKind } from '../../tree-collapse-state.js';
import EmptyRecycleBinModal from '../modals/EmptyRecycleBinModal.vue';

const MODAL_ID = 'recycle-bin';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();

const { entries, refresh, restore, forget, empty } = useRecycleBin();

const overlayRef = ref<HTMLElement | null>(null);
const query = ref('');
const { onKeydown: trapOnKeydown } = useFocusTrap('.rb-modal');
const modalStack = useModalStack();

/** Case-insensitive path match (Windows filesystem — always case-insensitive here). */
function pathsMatch(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Resolve an entry to its project. Prefer the id/name captured at close time;
 * fall back to a working-dir lookup for legacy entries that predate the field.
 */
const resolveProject: ResolveProject = (entry: RecycleBinEntry) => {
  if (entry.projectId) return { id: entry.projectId, name: entry.projectName || entry.projectId };
  const match = state.projects.find(
    p => pathsMatch(p.canonicalPath, entry.workingDir)
      || (p.alternatePaths ?? []).some(alt => pathsMatch(alt, entry.workingDir)),
  );
  return match ? { id: match.id, name: match.name } : null;
};

const tree = computed(() => buildRecycleTree(entries.value, resolveProject, query.value));

/**
 * Fold state persists across modal open/close (and restarts). Nodes start
 * collapsed, so the bin opens compact and only what the user opened stays open.
 */
const expansion = useTreeExpansion('recycle-bin');

function onToggle(kind: TreeNodeKind, key: string, event: Event): void {
  expansion.setExpanded(kind, key, (event.target as HTMLDetailsElement).open);
}
const shownCount = computed(() => tree.value.reduce((sum, p) => sum + p.count, 0));
const countLabel = computed(() =>
  query.value.trim()
    ? `${shownCount.value} shown · last 30 days`
    : `${entries.value.length} recoverable · last 30 days`,
);

function relativeClosed(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Exact close time as yyyy/mm/dd HH:mm. */
function formatCloseDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function close(): void {
  emit('update:visible', false);
}

async function onRestore(entry: RecycleBinEntry): Promise<void> {
  await restore(entry.id);
  if (entries.value.length === 0) close();
}

async function onRestoreFolder(folder: RecycleFolderNode): Promise<void> {
  // Snapshot ids first — restore mutates the entries list as it commits.
  for (const id of folder.entries.map(e => e.id)) {
    await restore(id);
  }
  if (entries.value.length === 0) close();
}

async function onForgetFolder(folder: RecycleFolderNode): Promise<void> {
  for (const id of folder.entries.map(e => e.id)) {
    await forget(id);
  }
}

/**
 * Emptying is irreversible (entries + their artifacts), so it is gated behind a
 * confirm. The bin is empty afterwards, so close it — same as the last restore.
 */
const confirmEmptyVisible = ref(false);

async function onConfirmEmpty(): Promise<void> {
  if (await empty()) {
    confirmEmptyVisible.value = false;
    close();
  }
}

function handleButton(): boolean {
  return true;
}

function onOverlayKeydown(event: KeyboardEvent): void {
  trapOnKeydown(event);
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

watch(() => props.visible, (visible) => {
  // Never leave the empty-confirm floating over a closed bin, or stale on reopen.
  confirmEmptyVisible.value = false;
  if (visible) {
    query.value = '';
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: FORM_KEYS });
    void refresh();
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

onUnmounted(() => {
  modalStack.pop(MODAL_ID);
});

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Recycle Bin"
      tabindex="-1"
      @click.self="close"
      @keydown="onOverlayKeydown"
    >
      <div class="modal rb-modal">
        <div class="rb-head">
          <h3 class="rb-title">🗑️ Recycle Bin</h3>
          <span class="rb-count">{{ countLabel }}</span>
          <span class="rb-spacer"></span>
          <button class="rb-clear focusable" type="button" :disabled="entries.length === 0" @click="confirmEmptyVisible = true">Empty bin</button>
          <button class="rb-x focusable" type="button" aria-label="Close" @click="close">✕</button>
        </div>

        <div class="rb-body">
          <div class="rb-toolbar">
            <label class="rb-search">
              <span class="rb-mag" aria-hidden="true">🔍</span>
              <input v-model="query" class="focusable" type="text" placeholder="Search name, CLI or path…" aria-label="Search recycle bin">
            </label>
          </div>

          <div v-if="entries.length === 0" class="rb-empty">No closed sessions to restore</div>
          <div v-else-if="tree.length === 0" class="rb-empty">No matches</div>

          <details
            v-for="project in tree"
            :key="project.id"
            class="rb-tree rb-project"
            :open="expansion.isExpanded('project', project.id)"
            @toggle="onToggle('project', project.id, $event)"
          >
            <summary>
              <span class="rb-tw" aria-hidden="true">▶</span>
              <span class="rb-p-icon" aria-hidden="true">📁</span>
              <span class="rb-p-label">{{ project.name }}</span>
              <span class="rb-node-count">{{ project.count }}</span>
            </summary>

            <template v-for="child in project.children" :key="project.id + ':' + (child.kind === 'group' ? child.id : child.key)">
              <!-- Runtime group → contains one or more folders. -->
              <details
                v-if="child.kind === 'group'"
                class="rb-tree rb-group"
                :open="expansion.isExpanded('group', child.id)"
                @toggle="onToggle('group', child.id, $event)"
              >
                <summary>
                  <span class="rb-tw" aria-hidden="true">▶</span>
                  <span class="rb-g-label">🗂️ {{ child.name }}</span>
                  <span class="rb-node-count">{{ child.count }}</span>
                </summary>
                <details
                  v-for="folder in child.folders"
                  :key="folder.key"
                  class="rb-tree rb-dir"
                  :open="expansion.isExpanded('folder', folder.key)"
                  @toggle="onToggle('folder', folder.key, $event)"
                >
                  <summary>
                    <span class="rb-tw" aria-hidden="true">▶</span>
                    <span class="rb-d-label" :title="folder.fullPath">{{ folder.label }}</span>
                    <span class="rb-node-count">{{ folder.count }}</span>
                  </summary>
                  <div class="rb-section-actions">
                    <button class="rb-mini focusable" type="button" @click="onRestoreFolder(folder)">↺ Restore all</button>
                    <button class="rb-mini rb-mini--danger focusable" type="button" @click="onForgetFolder(folder)">🗑 Forget all</button>
                  </div>
                  <div class="rb-entries">
                    <div v-for="entry in folder.entries" :key="entry.id" class="rb-row">
                      <div class="rb-info">
                        <div class="rb-name-line">
                          <span class="rb-name">{{ entry.name }}</span>
                          <span class="rb-cli">{{ getCliDisplayName(entry.cliType) }}</span>
                        </div>
                        <div class="rb-path" :title="entry.workingDir">{{ entry.workingDir }}</div>
                        <div class="rb-meta">
                          <span v-if="entry.runtimeGroupName" class="rb-grp">🗂️ {{ entry.runtimeGroupName }}</span>
                          <span>closed {{ relativeClosed(entry.closedAt) }} · {{ formatCloseDate(entry.closedAt) }}</span>
                        </div>
                      </div>
                      <div class="rb-actions">
                        <button class="rb-icon rb-icon--restore focusable" type="button" title="Restore" @click="onRestore(entry)">↺</button>
                        <button class="rb-icon rb-icon--forget focusable" type="button" title="Forget" @click="forget(entry.id)">🗑</button>
                      </div>
                    </div>
                  </div>
                </details>
              </details>

              <!-- Ungrouped folder → sits directly under the project (no group wrapper). -->
              <details
                v-else-if="child.kind === 'folder'"
                class="rb-tree rb-dir rb-dir--ungrouped"
                :open="expansion.isExpanded('folder', child.key)"
                @toggle="onToggle('folder', child.key, $event)"
              >
                <summary>
                  <span class="rb-tw" aria-hidden="true">▶</span>
                  <span class="rb-d-label" :title="child.fullPath">{{ child.label }}</span>
                  <span class="rb-node-count">{{ child.count }}</span>
                </summary>
                <div class="rb-section-actions">
                  <button class="rb-mini focusable" type="button" @click="onRestoreFolder(child)">↺ Restore all</button>
                  <button class="rb-mini rb-mini--danger focusable" type="button" @click="onForgetFolder(child)">🗑 Forget all</button>
                </div>
                <div class="rb-entries">
                  <div v-for="entry in child.entries" :key="entry.id" class="rb-row">
                    <div class="rb-info">
                      <div class="rb-name-line">
                        <span class="rb-name">{{ entry.name }}</span>
                        <span class="rb-cli">{{ getCliDisplayName(entry.cliType) }}</span>
                      </div>
                      <div class="rb-path" :title="entry.workingDir">{{ entry.workingDir }}</div>
                      <div class="rb-meta">
                        <span>closed {{ relativeClosed(entry.closedAt) }} · {{ formatCloseDate(entry.closedAt) }}</span>
                      </div>
                    </div>
                    <div class="rb-actions">
                      <button class="rb-icon rb-icon--restore focusable" type="button" title="Restore" @click="onRestore(entry)">↺</button>
                      <button class="rb-icon rb-icon--forget focusable" type="button" title="Forget" @click="forget(entry.id)">🗑</button>
                    </div>
                  </div>
                </div>
              </details>
            </template>
          </details>
        </div>

        <div class="rb-foot">
          <span class="rb-hint">A ↺ Restore · X Forget · B Close</span>
        </div>
      </div>
    </div>
  </Teleport>

  <EmptyRecycleBinModal
    v-model:visible="confirmEmptyVisible"
    :count="entries.length"
    @confirm="onConfirmEmpty"
  />
</template>

<style scoped>
.rb-modal {
  border: 2px solid var(--accent);
  border-radius: 10px;
  background: var(--bg-secondary);
  width: min(560px, 92vw);
  display: flex;
  flex-direction: column;
}
.rb-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.rb-title { margin: 0; font-size: 1.1rem; color: var(--text-primary); white-space: nowrap; }
.rb-count { color: var(--text-secondary); font-size: 0.8rem; }
.rb-spacer { margin-left: auto; }
.rb-clear {
  background: none; border: 1px solid var(--border); color: var(--text-secondary);
  border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 0.78rem;
}
.rb-clear:hover:not(:disabled) { border-color: #c55; color: #ff6666; }
.rb-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.rb-x { background: none; border: none; color: var(--text-secondary); font-size: 1.2rem; cursor: pointer; }
.rb-x:hover { color: var(--text-primary); }
.rb-body { padding: 12px 18px 18px; max-height: 62vh; overflow: auto; }
.rb-empty { text-align: center; padding: 40px; color: var(--text-secondary); }

/* ---------- toolbar / search ---------- */
.rb-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.rb-search {
  flex: 1; display: flex; align-items: center; gap: 6px;
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px;
}
.rb-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79, 208, 139, 0.25); }
.rb-search input {
  flex: 1; background: none; border: none; outline: none;
  color: var(--text-primary); font-size: 0.85rem; font-family: inherit;
}
.rb-mag { color: var(--text-secondary); font-size: 0.85rem; }

/* ---------- nested tree via <details> ---------- */
.rb-tree { border: none; }
.rb-tree > summary {
  list-style: none; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 6px;
}
.rb-tree > summary::-webkit-details-marker { display: none; }
.rb-tree > summary:hover { background: var(--bg-tertiary); }
.rb-tw {
  color: var(--text-secondary); font-size: 0.7rem; width: 12px; display: inline-block;
  transition: transform 0.12s ease;
}
.rb-tree[open] > summary .rb-tw { transform: rotate(90deg); }

.rb-project .rb-p-icon { color: var(--accent); }
.rb-project .rb-p-label { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }

.rb-group { margin-left: 14px; }
.rb-group .rb-g-label { font-size: 0.83rem; color: var(--text-primary); }

.rb-dir { margin-left: 28px; }
.rb-dir--ungrouped { margin-left: 14px; }
.rb-d-label {
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.rb-node-count {
  margin-left: auto; font-size: 0.68rem; color: var(--text-secondary);
  background: var(--bg-primary); border: 1px solid var(--border); border-radius: 999px;
  padding: 1px 8px; flex-shrink: 0;
}

.rb-section-actions { margin-left: 34px; margin-bottom: 8px; display: flex; gap: 8px; }
.rb-mini {
  font-size: 0.7rem; color: var(--text-secondary); background: none;
  border: 1px solid var(--border); border-radius: 4px; padding: 3px 9px; cursor: pointer;
}
.rb-mini:hover { border-color: var(--accent); color: var(--accent); }
.rb-mini--danger:hover { border-color: #c55; color: #ff6666; }

.rb-entries { margin-left: 34px; padding: 2px 0 6px; }
.rb-row {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px; padding: 9px 11px; margin-bottom: 7px; background: var(--bg-primary);
}
.rb-info { flex: 1; min-width: 0; }
.rb-name-line { display: flex; align-items: center; gap: 8px; }
.rb-name { font-size: 0.92rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-cli { background: var(--bg-tertiary); padding: 2px 8px; border-radius: 3px; font-size: 0.72rem; color: var(--accent); flex-shrink: 0; }
.rb-path { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.rb-meta { display: flex; gap: 10px; font-size: 0.72rem; color: var(--text-secondary); margin-top: 3px; flex-wrap: wrap; }
.rb-grp { color: var(--accent); }

.rb-actions { display: flex; gap: 6px; flex-shrink: 0; }
.rb-icon {
  width: 30px; height: 30px; border-radius: 4px; flex-shrink: 0;
  border: 1px solid var(--border); background: var(--bg-tertiary);
  color: var(--text-primary); cursor: pointer; font-size: 0.95rem;
}
.rb-icon--restore:hover { border-color: var(--accent); color: var(--accent); }
.rb-icon--forget:hover { border-color: #c55; color: #ff6666; }

.rb-foot { border-top: 1px solid var(--border); padding: 10px 18px; }
.rb-hint { font-size: 0.76rem; color: var(--text-secondary); }
</style>
