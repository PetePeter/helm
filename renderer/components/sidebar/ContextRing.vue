<script setup lang="ts">
/**
 * The session activity dot with its context fill around it. The dot says what the
 * session is doing (centralised colours, invariant 8); the ring says how full its
 * context is. Hovering shows the graph. Without a reading or limits it is the
 * plain dot in the same footprint, so rows never shift when the first reading lands.
 */
import { computed, ref } from 'vue';
import type { ContextUsageSample, SessionContextUsageSnapshot } from '../../../src/types/session.js';
import { contextRing, resolveContextLimits } from '../../../src/session/context-limits.js';
import { getActivityColor } from '../../state-colors.js';
import { resolveCliTypeRecord } from '../../utils.js';
import { sessionContextUsageTitle } from '../../session-context-usage.js';
import ContextSparkline from './ContextSparkline.vue';

const props = withDefaults(defineProps<{
  activityLevel: string;
  cliType?: string;
  contextUsage?: SessionContextUsageSnapshot;
  contextHistory?: ContextUsageSample[];
  /** Outer diameter in px. */
  size?: number;
}>(), { size: 16 });

const limits = computed(() => resolveContextLimits(
  props.cliType ? resolveCliTypeRecord(props.cliType) : null,
  props.contextUsage?.window,
));
const ring = computed(() => (props.contextUsage ? contextRing(props.contextUsage.tokens, limits.value) : undefined));
const thickness = computed(() => Math.max(2, Math.round(props.size * 0.2)));
const style = computed(() => ({
  '--ring-size': `${props.size}px`,
  '--ring-thickness': `${thickness.value}px`,
  '--ring-fill': String(ring.value?.fill ?? 0),
  '--dot-size': `${Math.max(4, Math.round(props.size * 0.38))}px`,
}));

// Fixed-position so the sidebar's scroll container cannot clip the card.
const cardAt = ref<{ top: number; left: number } | null>(null);
const hasGraph = computed(() => (props.contextHistory?.length ?? 0) >= 1);
function showCard(event: MouseEvent): void {
  if (!hasGraph.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  cardAt.value = { top: rect.bottom + 6, left: Math.max(rect.left - 8, 4) };
}
</script>

<template>
  <span
    class="context-ring"
    :class="[ring && `level-${ring.level}`, { 'has-ring': ring, overflow: ring?.overflow }]"
    :style="style"
    @mouseenter="showCard"
    @mouseleave="cardAt = null"
  >
    <span v-if="ring" class="context-ring__arc" />
    <span class="context-ring__dot" :style="{ background: getActivityColor(activityLevel) }" />
    <Teleport to="body">
      <div v-if="cardAt" class="context-card" :style="{ top: `${cardAt.top}px`, left: `${cardAt.left}px` }">
        <div class="context-card__head">{{ sessionContextUsageTitle(contextUsage) }}</div>
        <ContextSparkline
          :samples="contextHistory"
          :window="contextUsage?.window"
          :limits="limits"
          :width="280"
          :height="90"
          detailed
        />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.context-ring {
  --ring-color: var(--accent);
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: var(--ring-size);
  height: var(--ring-size);
}
.context-ring.level-warn { --ring-color: var(--status-blocked); }
.context-ring.level-hot { --ring-color: var(--danger); }
.context-ring__arc {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(var(--ring-color) calc(var(--ring-fill) * 360deg), var(--border) 0);
  /* Punch the middle out so the card behind shows through, whatever its fill. */
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--ring-thickness)), #000 calc(100% - var(--ring-thickness)));
  mask: radial-gradient(farthest-side, transparent calc(100% - var(--ring-thickness)), #000 calc(100% - var(--ring-thickness)));
}
.context-ring__dot {
  width: var(--dot-size);
  height: var(--dot-size);
  border-radius: 50%;
}
/* Past the circle: the ring heartbeats; reduce-motion keeps a static halo instead. */
.context-ring.overflow { animation: context-heartbeat 1.1s infinite; border-radius: 50%; }
@keyframes context-heartbeat {
  0%, 60%, 100% { transform: scale(1); box-shadow: 0 0 0 0 transparent; }
  10% { transform: scale(1.2); box-shadow: 0 0 6px 1px var(--danger); }
  22% { transform: scale(1); }
  34% { transform: scale(1.14); box-shadow: 0 0 4px 1px var(--danger); }
}
@media (prefers-reduced-motion: reduce) {
  .context-ring.overflow { animation: none; box-shadow: 0 0 5px 1px var(--danger); }
}
.context-card {
  position: fixed;
  z-index: 1000;
  padding: var(--spacing-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.context-card__head {
  margin-bottom: var(--spacing-xs);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}
</style>
