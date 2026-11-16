<script setup lang="ts">
import { computed } from 'vue';
import { getDisplayTitle } from '../../types.js';
import TickerText from '../common/TickerText.vue';

const props = withDefaults(defineProps<{
  humanId?: string;
  title: string;
  type?: 'bug' | 'feature' | 'research';
  status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done' | 'suggested';
  compact?: boolean;
  interactive?: boolean;
}>(), {
  compact: false,
  interactive: true,
});

const emit = defineEmits<{
  click: [];
  copy: [];
}>();

// Row one reads "P-0001 - coding"; without a human id the status stands alone.
const statusText = computed(() => (props.humanId ? `- ${props.status}` : props.status));
const displayTitle = computed(() => getDisplayTitle(props.title, props.type));

function onClick(): void {
  if (props.interactive) emit('click');
}

function onKeyActivate(event: KeyboardEvent): void {
  if (!props.interactive) return;
  event.preventDefault();
  emit('click');
}
</script>

<template>
  <div
    class="plan-chip"
    :class="[
      compact ? 'plan-chip--compact' : 'plan-chip--two-line',
      `plan-chip--${status}`,
    ]"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :title="humanId ? `${humanId} ${title}` : title"
    @click="onClick"
    @keydown.enter="onKeyActivate"
    @keydown.space="onKeyActivate"
  >
    <slot v-if="compact" />
    <template v-else>
      <!-- The state colour follows the persisted status the chip-bar store last loaded. -->
      <span class="plan-chip__top">
        <span v-if="humanId" class="plan-chip__id">{{ humanId }}</span>
        <span class="plan-chip__status">{{ statusText }}</span>
        <button
          v-if="humanId"
          type="button"
          class="plan-chip__copy"
          :title="`Copy reference ${humanId}`"
          :aria-label="`Copy reference ${humanId}`"
          @click.stop="emit('copy')"
        >⧉</button>
      </span>
      <TickerText class="plan-chip__title" :text="displayTitle" />
    </template>
  </div>
</template>

<style scoped>
.plan-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.plan-chip:hover {
  background: color-mix(in srgb, var(--bg-tertiary) 82%, white 18%);
  border-color: var(--text-secondary);
}

.plan-chip--coding { border-color: var(--status-coding); }
.plan-chip--ready { border-color: var(--status-ready); }
.plan-chip--review { border-color: var(--status-review); }
.plan-chip--blocked { border-color: var(--status-blocked); }
.plan-chip--planning { border-color: var(--status-planning); }
.plan-chip--done { border-color: var(--status-done); }
.plan-chip--suggested { border-color: var(--status-suggested); }

.plan-chip--compact {
  gap: 6px;
  max-width: 220px;
  font-size: 0.75rem;
  color: var(--text-primary);
  flex-shrink: 0;
  cursor: default;
  user-select: text;
}

.plan-chip--compact:hover {
  background: var(--bg-tertiary);
}

.plan-chip--two-line {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 180px;
  max-width: 100%;
  padding: 4px 9px;
  border-radius: 9px;
}
.plan-chip__top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.plan-chip__id { font-weight: 600; }
.plan-chip__status { color: var(--text-secondary); }
/* Clipping/ellipsis/ticker behaviour lives in TickerText. */
.plan-chip__title { font-size: 12px; }
.plan-chip__copy {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  padding: 0 0 0 2px;
  opacity: 0.55;
  transition: opacity 0.15s;
}
.plan-chip__copy:hover { opacity: 1; }
</style>
