<script setup lang="ts">
defineProps<{
  actions: Array<{ label: string; sequence: string; preview: string }>;
}>();

const emit = defineEmits<{
  actionClick: [sequence: string];
}>();

// Alt+1..9 and Alt+0 fire the first ten actions (see useNumberAccelerator).
// Slot 0 = the 10th action. The ⌥ glyph keeps the badge visually distinct
// from the Ctrl-based ^n session-jump badge.
function acceleratorDigit(index: number): number | null {
  if (index < 9) return index + 1;
  if (index === 9) return 0;
  return null;
}

function accelerator(index: number): string | null {
  const digit = acceleratorDigit(index);
  return digit === null ? null : `⌥${digit}`;
}

function tooltip(preview: string, index: number): string {
  const digit = acceleratorDigit(index);
  return digit === null ? preview : `Alt+${digit} — ${preview}`;
}
</script>

<template>
  <div class="chip-action-bar">
    <button
      v-for="(action, index) in actions"
      :key="`${action.label}:${action.sequence}`"
      type="button"
      class="chip-action-btn"
      :title="tooltip(action.preview, index)"
      @click="emit('actionClick', action.sequence)"
    >
      <span class="chip-action-btn__top">
        <span
          v-if="accelerator(index)"
          class="chip-action-btn__accel"
          aria-hidden="true"
        >{{ accelerator(index) }}</span>
        <span class="chip-action-btn__label">{{ action.label }}</span>
      </span>
      <span class="chip-action-btn__preview">{{ action.preview }}</span>
    </button>
  </div>
</template>

<style scoped>
.chip-action-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
}

.chip-action-btn {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--text-primary);
  border-radius: 9px;
  padding: 4px 9px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 180px;
  max-width: 100%;
  overflow: hidden;
  text-align: left;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  user-select: none;
}

.chip-action-btn:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-color: var(--accent);
}

.chip-action-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.chip-action-btn__top {
  display: flex;
  align-items: center;
  min-width: 0;
}

.chip-action-btn__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-action-btn__preview {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

/* Alt+number accelerator badge — uses the glyph in the template to stay
   distinct from the Ctrl-based session-jump badge. */
.chip-action-btn__accel {
  margin-right: 5px;
  font-family: monospace;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.65;
  color: var(--accent);
}
</style>
