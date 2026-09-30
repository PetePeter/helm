/**
 * useRuntimeGroups — reactive state for ad-hoc runtime session groups.
 *
 * Owns the live list of runtime groups and keeps it fresh via the
 * runtime-group:changed event. Mutators are thin wrappers over the preload
 * client; each awaits the client then refreshes defensively (the changed-event
 * also triggers a refresh, so this is belt-and-braces to avoid stale UI when an
 * event is missed).
 */
import { ref } from 'vue';
import { runtimeGroupClient, eventsClient } from '../ipc/clients.js';
import type { RuntimeGroup } from '../../src/types/runtime-group.js';

const groups = ref<RuntimeGroup[]>([]);
let subscribed = false;

async function refresh(): Promise<void> {
  try {
    const list = await runtimeGroupClient.runtimeGroupList();
    groups.value = list ?? [];
  } catch {
    groups.value = [];
  }
}

/** Subscribe once to keep the group list live. Safe to call repeatedly. */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  eventsClient.onRuntimeGroupChanged?.(() => { void refresh(); });
  void refresh();
}

async function create(name: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupCreate(name);
  await refresh();
}

async function rename(id: string, name: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupRename(id, name);
  await refresh();
}

async function setColor(id: string, color: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupSetColor(id, color);
  await refresh();
}

async function setCollapsed(id: string, collapsed: boolean): Promise<void> {
  await runtimeGroupClient.runtimeGroupSetCollapsed(id, collapsed);
  await refresh();
}

async function addSession(groupId: string, sessionId: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupAddSession(groupId, sessionId);
  await refresh();
}

async function removeSession(sessionId: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupRemoveSession(sessionId);
  await refresh();
}

async function closeGroup(id: string): Promise<void> {
  await runtimeGroupClient.runtimeGroupCloseGroup(id);
  await refresh();
}

export function useRuntimeGroups() {
  return { groups, ensureSubscribed, refresh, create, rename, setColor, setCollapsed, addSession, removeSession, closeGroup };
}
