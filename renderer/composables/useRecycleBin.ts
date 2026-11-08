/**
 * useRecycleBin — reactive state for the closed-session recycle bin.
 *
 * Owns the badge count + modal visibility and keeps the count live via the
 * recycle-bin:changed event. Restore is one main-process operation so profile
 * selection, spawn, and metadata restoration stay bound to the same runtime.
 */
import { ref } from 'vue';
import { recycleBinClient, eventsClient } from '../ipc/clients.js';
import type { RecycleBinEntry } from '../../src/types/recycle-bin.js';

const entries = ref<RecycleBinEntry[]>([]);
const count = ref(0);
const modalVisible = ref(false);
let subscribed = false;

async function refresh(): Promise<void> {
  try {
    const list = await recycleBinClient.recycleBinList();
    entries.value = list ?? [];
    count.value = entries.value.length;
  } catch {
    entries.value = [];
    count.value = 0;
  }
}

/** Subscribe once to keep the badge count live. Safe to call repeatedly. */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  eventsClient.onRecycleBinChanged?.(() => { void refresh(); });
  void refresh();
}

// Ids currently mid-restore, so a rapid double-click can't spawn the same session twice.
const restoring = new Set<string>();

async function restore(id: string): Promise<void> {
  if (restoring.has(id)) return;
  restoring.add(id);
  try {
    // Main resolves the active profile runtime, restores metadata, and commits
    // before returning; a failed restore stays in the bin for retry.
    const entry = await recycleBinClient.recycleBinRestore(id);
    if (!entry) return;
    await refresh();
  } finally {
    restoring.delete(id);
  }
}

async function forget(id: string): Promise<void> {
  await recycleBinClient.recycleBinForget(id);
  await refresh();
}

async function empty(): Promise<void> {
  await recycleBinClient.recycleBinEmpty();
  await refresh();
}

export function useRecycleBin() {
  return { entries, count, modalVisible, ensureSubscribed, refresh, restore, forget, empty };
}
