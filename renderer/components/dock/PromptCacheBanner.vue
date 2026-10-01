<script setup lang="ts">
/**
 * PromptCacheBanner — warns above and below the terminal that the selected session's
 * prompt cache has likely expired, so the next prompt re-reads the whole
 * context. Orange past the CLI type's short cache, red past its long one
 * (where AutoFreezer freezes it), blue once frozen.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatElapsed } from '../../../src/utils/time-parser.js';
import { promptStaleness, warnAfterMs, expireAfterMs } from '../../../src/session/prompt-staleness.js';
import { resolveCliTypeRecord } from '../../utils.js';

const props = defineProps<{
  cliType: string;
  lastPromptAt?: number;
  frozen?: boolean;
  /** 'bottom' = the copy under the terminal (border on top instead). */
  placement?: 'top' | 'bottom';
}>();

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 15_000); });
onBeforeUnmount(() => { if (clock) clearInterval(clock); });

const thresholds = computed(() => resolveCliTypeRecord(props.cliType) ?? undefined);
const stage = computed(() => props.frozen ? 'frozen' : promptStaleness(props.lastPromptAt, now.value, thresholds.value));
const text = computed(() => {
  if (stage.value === 'frozen') return '❄ Frozen — no input reaches this session';
  const ms = stage.value === 'expired' ? expireAfterMs(thresholds.value) : warnAfterMs(thresholds.value);
  return `⚠ ${ms / 60_000} min cache expired — last prompt ${formatElapsed(now.value - (props.lastPromptAt ?? now.value))} ago`;
});
</script>

<template>
  <div v-if="stage !== 'fresh'" class="prompt-cache-banner" :class="[`prompt-cache-banner--${stage}`, { 'prompt-cache-banner--bottom': placement === 'bottom' }]">{{ text }}</div>
</template>

<style scoped>
.prompt-cache-banner {
  padding: 4px 10px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-bottom: 1px solid var(--border-color, #333);
}
.prompt-cache-banner--bottom { border-bottom: none; border-top: 1px solid var(--border-color, #333); }
.prompt-cache-banner--warn { color: #ff9f43; }
.prompt-cache-banner--expired { color: #ff5c5c; }
.prompt-cache-banner--frozen { color: #8cbcff; }
</style>
