<script setup lang="ts">
import { computed } from 'vue';
import { getDisplayTitle } from '../../types.js';
import TickerText from './TickerText.vue';

const props = defineProps<{
  humanId?: string;
  title: string;
  type?: 'bug' | 'feature' | 'research';
  status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done';
}>();

const emit = defineEmits<{
  click: [];
  copy: [];
}>();

// Row one reads "P-0001 - coding"; without a human id the status stands alone.
const statusText = computed(() => (props.humanId ? `- ${props.status}` : props.status));
const displayTitle = computed(() => getDisplayTitle(props.title, props.type));

function onKeyActivate(): void {
  emit('click');
}
</script>

<template>
  <div
    class="plan-chip plan-chip--two-line"
    :class="`plan-chip--${status}`"
    role="button"
    tabindex="0"
    :title="humanId ? `${humanId} ${title}` : title"
    @click="emit('click')"
    @keydown.enter.prevent="onKeyActivate"
    @keydown.space.prevent="onKeyActivate"
  >
    <!-- The state colour comes from the plan-chip--<status> class, so it always
         follows the persisted status the chip-bar store last loaded. -->
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
  </div>
</template>

<style scoped>
/* Two-row layout is scoped here so DraftEditor's single-line .plan-chip spans
   keep the shared global styling. */
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
