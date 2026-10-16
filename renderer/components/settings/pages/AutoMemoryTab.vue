<script setup lang="ts">
/**
 * AutoMemoryTab.vue: which model records memories for every session, and the
 * auto-save / auto-recall switches. Helm uses the picked model silently — no
 * session row, nothing in the chat.
 */
import { computed, onMounted } from 'vue';
import { useAutoMemoryStore } from '../../../stores/auto-memory.js';
import { DEFAULT_JUDGE_PROMPT, type RecordingModelOption } from '../../../../src/types/auto-memory.js';

const store = useAutoMemoryStore();

onMounted(() => { void store.load(); });

const optionLabel = (model: RecordingModelOption): string =>
  model.note ? `${model.name} (${model.note})` : model.name;

/** Said before the pick, not after: picking saves at once. */
const offersRealCli = computed(() => store.models.some((model) => model.kind === 'cli' && model.available));

const checked = (event: Event): boolean => (event.target as HTMLInputElement).checked;

/** What the judge is told now: the edit, else the default the user starts from. */
const judgePrompt = computed(() => store.settings.judgePrompt || DEFAULT_JUDGE_PROMPT);
const promptEdited = computed(() => Boolean(store.settings.judgePrompt));
</script>

<template>
  <div class="settings-auto-memory-panel settings-sections">
    <div class="settings-panel__header settings-span">
      <span class="settings-panel__title">Auto memory</span>
    </div>

    <div class="settings-help settings-span">
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

    <span v-if="offersRealCli" class="auto-memory-note settings-span">
      A real CLI is started once for every pass and loads its whole system prompt each time: about 28k tokens for Claude Code.
      Auto-save runs after every turn of every session, and on the same provider it draws on the quota of the sessions it serves.
      An API tool with a small model costs far less.
    </span>
    <span v-if="store.inert" class="auto-memory-note settings-span">No recording model picked: auto-save does nothing until you pick one.</span>
    <span v-if="store.stale" class="auto-memory-note settings-span">The picked model can no longer record, so auto-save does nothing: pick another.</span>
    <span v-if="store.testOutcome" class="auto-memory-note settings-span">{{ store.testOutcome }}</span>

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

    <label class="auto-memory-prompt settings-span">
      <span>Judge prompt: what the recording model is told before each turn it judges</span>
      <textarea
        class="auto-memory-prompt__text focusable"
        rows="14"
        spellcheck="false"
        :value="judgePrompt"
        @change="store.save({ judgePrompt: ($event.target as HTMLTextAreaElement).value })"
      />
    </label>
    <div class="auto-memory-setting">
      <button
        type="button"
        class="btn btn--secondary btn--sm focusable"
        :disabled="!promptEdited"
        @click="store.save({ judgePrompt: '' })"
      >Reset to default</button>
      <span class="auto-memory-note">{{ promptEdited ? 'Using your edited prompt.' : 'Using the default prompt.' }}</span>
    </div>

    <span v-if="store.error" class="auto-memory-note settings-span">{{ store.error }}</span>
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

.auto-memory-prompt {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.auto-memory-prompt__text {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--spacing-sm);
}

.auto-memory-note {
  display: block;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
</style>
