<script setup lang="ts">
/**
 * VoiceTab.vue — speech tool paths (OpenWhispr STT, Piper TTS, ffmpeg).
 * Shared by every voice consumer (Telegram voice notes, operator PTT/calls),
 * so it lives in its own tab. The keys are still stored in the telegram
 * config block for backward compatibility.
 */
import { ref, watch } from 'vue';
import { dialogClient } from '../../ipc/clients.js';

export interface VoiceConfig {
  openWhisprPath: string;
  piperPath: string;
  piperVoicePath: string;
  ffmpegPath: string;
}

type VoiceField = keyof VoiceConfig;

const props = defineProps<{ config: VoiceConfig }>();

const emit = defineEmits<{
  updateField: [field: VoiceField, value: string];
}>();

const draft = ref<VoiceConfig>({ ...props.config });
watch(() => props.config, (c) => { draft.value = { ...c }; });

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPending(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function debouncedEmit(field: VoiceField): void {
  cancelPending();
  saveTimer = setTimeout(() => emit('updateField', field, draft.value[field]), 500);
}

function immediateEmit(field: VoiceField): void {
  cancelPending();
  emit('updateField', field, draft.value[field]);
}

const EXE_FILTERS = [{ name: 'Executables', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }];
const VOICE_FILTERS = [{ name: 'Piper Voices', extensions: ['onnx'] }, { name: 'All Files', extensions: ['*'] }];

const FIELDS: { key: VoiceField; label: string; placeholder: string; filters?: typeof EXE_FILTERS }[] = [
  { key: 'openWhisprPath', label: 'OpenWhispr Path', placeholder: 'C:\\Program Files\\OpenWhispr' },
  { key: 'piperPath', label: 'Piper Path', placeholder: 'C:\\Users\\you\\AppData\\Local\\Programs\\piper\\piper\\piper.exe', filters: EXE_FILTERS },
  { key: 'piperVoicePath', label: 'Piper Voice Path', placeholder: 'C:\\Users\\you\\AppData\\Local\\Programs\\piper\\voices\\voice.onnx', filters: VOICE_FILTERS },
  { key: 'ffmpegPath', label: 'ffmpeg Path', placeholder: 'C:\\...\\ffmpeg.exe', filters: EXE_FILTERS },
];

async function browse(field: (typeof FIELDS)[number]): Promise<void> {
  // OpenWhispr is an install folder; the others are single files.
  const selected = field.filters
    ? await dialogClient.dialogShowOpenFile?.(field.filters)
    : await dialogClient.dialogOpenFolder();
  if (!selected) return;
  draft.value[field.key] = selected;
  immediateEmit(field.key);
}
</script>

<template>
  <div class="settings-voice-panel">
    <section class="voice-section">
      <h4>Speech tools</h4>
      <label v-for="f in FIELDS" :key="f.key" class="voice-field" :data-field="f.key">
        {{ f.label }}
        <div class="voice-path-row">
          <input
            v-model="draft[f.key]"
            type="text"
            :placeholder="f.placeholder"
            @input="debouncedEmit(f.key)"
            @blur="immediateEmit(f.key)"
          />
          <button class="voice-browse-btn" type="button" @click="browse(f)">📂</button>
        </div>
      </label>
    </section>
  </div>
</template>

<style scoped>
.voice-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
}

.voice-section h4 {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.voice-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.voice-path-row {
  display: flex;
  gap: var(--spacing-xs);
  align-items: center;
}

.voice-path-row input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
}

.voice-path-row input:focus {
  outline: none;
  border-color: var(--accent);
}

.voice-browse-btn {
  flex-shrink: 0;
  padding: 0 var(--spacing-xs);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: 1;
  height: 100%;
}

.voice-browse-btn:hover {
  background: var(--bg-hover);
}
</style>
