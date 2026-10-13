<script setup lang="ts">
/**
 * AutoMemoryTab.vue: which model records memories for every session, and the
 * auto-save / auto-recall switches. Helm uses the picked model silently — no
 * session row, nothing in the chat.
 */
import { onMounted } from 'vue';
import { useAutoMemoryStore } from '../../stores/auto-memory.js';
import type { RecordingModelOption } from '../../../src/types/auto-memory.js';

const store = useAutoMemoryStore();

onMounted(() => { void store.load(); });

const optionLabel = (model: RecordingModelOption): string =>
  model.note ? `${model.name} (${model.note})` : model.name;

const checked = (event: Event): boolean => (event.target as HTMLInputElement).checked;
</script>

<template>
  <div class="settings-auto-memory-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Auto memory</span>
    </div>

    <div class="settings-help">
      <p>Helm records the key facts of every session as memories and hints at them later.
        The recording model works silently: it opens no session and never writes to your chat.</p>
    </div>

    <label class="auto-memory-setting">
      <span>Recording model</span>
      <select
        class="btn btn--secondary btn--sm focusable"
        :value="store.settings.recordingModel"
        @change="store.save({ recordingModel: ($event.target as HTMLSelectElement).value })"
      >
        <option value="">None</option>
        <option v-if="!store.inert && !store.picked" :value="store.settings.recordingModel" disabled>Deleted CLI type</option>
        <option
          v-for="model in store.models"
          :key="model.id"
          :value="model.id"
          :disabled="!model.available"
        >{{ optionLabel(model) }}</option>
      </select>
      <button
        type="button"
        class="btn btn--secondary btn--sm focusable"
        :disabled="store.inert || store.stale || store.testing"
        @click="store.testModel()"
      >{{ store.testing ? 'Testing…' : 'Test' }}</button>
    </label>

    <span v-if="store.inert" class="auto-memory-note">No recording model picked: auto-save does nothing until you pick one.</span>
    <span v-if="store.stale" class="auto-memory-note">The picked model can no longer record, so auto-save does nothing: pick another.</span>
    <span v-if="store.testOutcome" class="auto-memory-note">{{ store.testOutcome }}</span>

    <label class="auto-memory-setting">
      <input
        type="checkbox"
        class="focusable"
        :checked="store.settings.autoSave"
        @change="store.save({ autoSave: checked($event) })"
      />
      <span>Auto-save: record key memories after each turn</span>
    </label>

    <label class="auto-memory-setting">
      <input
        type="checkbox"
        class="focusable"
        :checked="store.settings.autoRecall"
        @change="store.save({ autoRecall: checked($event) })"
      />
      <span>Auto-recall: hint at related memories when you send a prompt</span>
    </label>

    <span v-if="store.error" class="auto-memory-note">{{ store.error }}</span>
  </div>
</template>

<style scoped>
.auto-memory-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.auto-memory-note {
  display: block;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
</style>
