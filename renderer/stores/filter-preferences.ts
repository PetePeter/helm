import { ref, watch, type Ref } from 'vue';
import type { FilterPreferenceChanged, PlanFilterPreferences } from '../../src/types/filter-preference.js';
import { configClient } from '../ipc/clients.js';

interface PreferenceEntry<T> {
  value: Ref<T>;
  normalize: (value: unknown) => T;
  ready: Promise<void>;
  loaded: boolean;
  changedBeforeLoad: boolean;
  skipWriteValue: string | null;
  persistOnChange: boolean;
  persist: () => Promise<void>;
}

const entries = new Map<string, PreferenceEntry<unknown>>();
let stopListening: (() => void) | undefined;

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function applyRemoteChange(change: FilterPreferenceChanged): void {
  const entry = entries.get(change.id);
  if (!entry) return;
  const normalized = entry.normalize(change.value);
  const nextSerialized = serialize(normalized);
  if (serialize(entry.value.value) === nextSerialized) return;
  if (!entry.loaded) entry.changedBeforeLoad = true;
  entry.skipWriteValue = nextSerialized;
  entry.value.value = normalized;
}

function ensureListener(): void {
  if (stopListening) return;
  stopListening = configClient.onFilterPreferenceChanged?.(applyRemoteChange);
}

/** Register one stable persistence key shared by every view using that preference. */
export function registerFilterPreference<T>(
  id: string,
  initialValue: T,
  normalize: (value: unknown) => T,
  options: { persistOnChange?: boolean } = {},
): { value: Ref<T>; ready: Promise<void>; persist: () => Promise<void> } {
  ensureListener();
  const existing = entries.get(id);
  if (existing) return existing as PreferenceEntry<T>;

  let entry: PreferenceEntry<T>;
  entry = {
    value: ref(initialValue) as Ref<T>,
    normalize,
    ready: Promise.resolve(),
    loaded: false,
    changedBeforeLoad: false,
    skipWriteValue: null,
    persistOnChange: options.persistOnChange !== false,
    persist: async () => {
      if (!entry.loaded) entry.changedBeforeLoad = true;
      await entry.ready;
      await persistEntry(id, entry, entry.normalize(entry.value.value));
    },
  };
  entries.set(id, entry as PreferenceEntry<unknown>);

  watch(entry.value, (nextValue) => {
    const serialized = serialize(nextValue);
    if (entry.skipWriteValue === serialized) {
      entry.skipWriteValue = null;
      return;
    }
    if (!entry.loaded) {
      entry.changedBeforeLoad = true;
      return;
    }
    if (entry.persistOnChange) void persistEntry(id, entry, nextValue);
  }, { deep: true });

  const read = configClient.configGetFilterPreference;
  const loadValue = typeof read === 'function'
    ? read(id)
    : id === 'plan.filters' ? configClient.configGetPlanFilters?.() : undefined;
  entry.ready = Promise.resolve(loadValue)
    .then((saved) => {
      if (!entry.changedBeforeLoad && saved !== undefined) {
        const normalized = normalize(saved);
        const serialized = serialize(normalized);
        if (serialize(entry.value.value) !== serialized) {
          entry.skipWriteValue = serialized;
          entry.value.value = normalized;
        }
      }
      entry.loaded = true;
      if (entry.changedBeforeLoad) {
        if (entry.persistOnChange) void persistEntry(id, entry, entry.value.value);
      }
    })
  .catch((error) => {
      console.error(`[FilterPreferences] Failed to load ${id}:`, error);
      entry.loaded = true;
      if (entry.changedBeforeLoad && entry.persistOnChange) {
        void persistEntry(id, entry, entry.value.value);
      }
    });

  return entry;
}

async function persistEntry<T>(id: string, entry: PreferenceEntry<T>, value: T): Promise<void> {
  try {
    const write = configClient.configSetFilterPreference;
    let result: unknown;
    if (typeof write === 'function') result = await write(id, value);
    else if (id === 'plan.filters') result = await configClient.configSetPlanFilters?.(value as PlanFilterPreferences);
    else throw new Error('Filter preference persistence API is unavailable');
    if (result && typeof result === 'object' && 'success' in result && result.success === false) {
      throw new Error('Filter preference persistence was rejected');
    }
  } catch (error) {
    console.error(`[FilterPreferences] Failed to save ${id}:`, error);
  }
}
