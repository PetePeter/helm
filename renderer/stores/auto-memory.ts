/**
 * Auto memory store — the recording model and the auto-save / auto-recall
 * switches, mirrored from main. Main owns the truth: every save reads back
 * what was actually stored, so a refused pick never lingers on screen.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { configClient } from '../ipc/clients.js';
import {
  DEFAULT_AUTO_MEMORY_SETTINGS,
  type AutoMemorySettings,
  type AutoMemoryState,
  type RecordingModelOption,
} from '../../src/types/auto-memory.js';

export const useAutoMemoryStore = defineStore('autoMemory', () => {
  const settings = ref<AutoMemorySettings>({ ...DEFAULT_AUTO_MEMORY_SETTINGS });
  const models = ref<RecordingModelOption[]>([]);
  /** Why the last save was refused; empty when it went through. */
  const error = ref('');
  /** Outcome of the last test run, in words; empty before one ran. */
  const testOutcome = ref('');
  const testing = ref(false);

  /** Auto-save needs a model: with none picked the switch does nothing. */
  const inert = computed(() => !settings.value.recordingModel);
  /** The stored pick as the picker knows it; undefined when its CLI type was deleted. */
  const picked = computed(() => models.value.find((model) => model.id === settings.value.recordingModel));
  /** A model is stored but can no longer record (deleted, or no longer a complete API tool). */
  const stale = computed(() => !inert.value && !picked.value?.available);

  function apply(state: AutoMemoryState): boolean {
    if (!state.success) return false;
    settings.value = state.settings;
    models.value = state.models;
    return true;
  }

  async function load(): Promise<void> {
    apply(await configClient.configGetAutoMemory());
  }

  async function save(updates: Partial<AutoMemorySettings>): Promise<void> {
    const result = await configClient.configSetAutoMemory(updates);
    testOutcome.value = '';
    if (apply(result)) {
      error.value = '';
      return;
    }
    error.value = result.success ? '' : result.error;
    // The controls bind one-way: re-read so a refused save shows the stored value.
    await load();
  }

  async function testModel(): Promise<void> {
    testing.value = true;
    testOutcome.value = '';
    try {
      const result = await configClient.configTestAutoMemoryModel();
      if (result.status === 'ok') testOutcome.value = 'The model answered.';
      else testOutcome.value = result.status === 'inert' ? result.reason : `Failed: ${result.error}`;
    } finally {
      testing.value = false;
    }
  }

  return { settings, models, error, testOutcome, testing, inert, picked, stale, load, save, testModel };
});
