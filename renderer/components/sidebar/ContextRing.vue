<script setup lang="ts">
/**
 * The session activity dot with its context fill around it. The dot says what the
 * session is doing (centralised colours, invariant 8); the ring says how full its
 * context is. Hovering shows the graph. Without a reading or limits it is the
 * plain dot in the same footprint, so rows never shift when the first reading lands.
 */
import { computed, ref } from 'vue';
import type { ContextUsageSample, SessionContextUsageSnapshot, SessionQuotaUsageSnapshot } from '../../../src/types/session.js';
import { contextRing, resolveContextLimits } from '../../../src/session/context-limits.js';
import { isFreshQuotaUsageSnapshot, quotaUsageLevel, SESSION_QUOTA_USAGE_MAX_AGE_MS } from '../../../src/session/quota-usage.js';
import { getActivityColor } from '../../state-colors.js';
import { resolveCliTypeRecord } from '../../utils.js';
import { formatQuotaResetIn, sessionContextUsageTitle } from '../../session-context-usage.js';
import ContextSparkline from './ContextSparkline.vue';

const props = withDefaults(defineProps<{
  activityLevel: string;
  cliType?: string;
  contextUsage?: SessionContextUsageSnapshot;
  quotaUsage?: SessionQuotaUsageSnapshot | null;
  contextHistory?: ContextUsageSample[];
  /** Outer diameter in px. */
  size?: number;
}>(), { size: 16 });

const limits = computed(() => resolveContextLimits(
  props.cliType ? resolveCliTypeRecord(props.cliType) : null,
  props.contextUsage?.window,
));
const ring = computed(() => (props.contextUsage ? contextRing(props.contextUsage.tokens, limits.value) : undefined));
// Whole-pixel radii keep the stroke edges crisp; a fractional edge anti-aliases the gap away.
const thickness = computed(() => Math.max(2, Math.round(props.size * 0.18)));
const quotaGap = computed(() => Math.max(2, Math.round(props.size * 0.12)));
const quota = computed(() => (props.quotaUsage && isFreshQuotaUsageSnapshot(props.quotaUsage, Date.now(), SESSION_QUOTA_USAGE_MAX_AGE_MS)
  ? props.quotaUsage
  : null));
const indicatorSize = computed(() => props.size + (quota.value ? 2 * (quotaGap.value + thickness.value) : 0));
const ringRadius = computed(() => (props.size - thickness.value) / 2);
const quotaRadius = computed(() => (indicatorSize.value - thickness.value) / 2);
/** Half-circle arc around the indicator's centre; `from` is the start side, sweeping clockwise. */
function quotaArc(from: 'left' | 'right'): string {
  const c = indicatorSize.value / 2;
  const r = quotaRadius.value;
  const [x0, x1] = from === 'left' ? [c - r, c + r] : [c + r, c - r];
  return `M${x0} ${c} A${r} ${r} 0 0 1 ${x1} ${c}`;
}
const style = computed(() => ({
  '--ring-size': `${props.size}px`,
  '--indicator-size': `${indicatorSize.value}px`,
  '--ring-thickness': `${thickness.value}px`,
  '--dot-size': `${Math.max(4, Math.round(props.size * 0.38))}px`,
}));

// Fixed-position so the sidebar's scroll container cannot clip the card.
const cardAt = ref<{ top: number; left: number } | null>(null);
const hasGraph = computed(() => (props.contextHistory?.length ?? 0) >= 1);
// Bars show what is LEFT, so they drain right-to-left like the arcs.
const quotaRows = computed(() => (quota.value
  ? ([['5h', quota.value.fiveHour], ['Week', quota.value.weekly]] as const).map(([label, window]) => ({
    label,
    leftPercent: Math.round(100 - window.usedPercent),
    level: quotaUsageLevel(window.usedPercent),
    resetIn: formatQuotaResetIn(window.resetsAtEpochMs),
  }))
  : []));
function showCard(event: MouseEvent): void {
  if (!hasGraph.value && !quotaRows.value.length) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  cardAt.value = { top: rect.bottom + 6, left: Math.max(rect.left - 8, 4) };
}
</script>

<template>
  <span
    class="context-ring"
    :class="{ 'has-quota': quota }"
    :style="style"
    @mouseenter="showCard"
    @mouseleave="cardAt = null"
  >
    <svg v-if="quota" class="quota-ring" :viewBox="`0 0 ${indicatorSize} ${indicatorSize}`" aria-hidden="true">
      <path class="quota-ring__track" :d="quotaArc('left')" />
      <path class="quota-ring__track" :d="quotaArc('right')" />
      <path
        class="quota-ring__arc"
        :class="`level-${quotaUsageLevel(quota.fiveHour.usedPercent)}`"
        pathLength="100"
        :style="{ strokeDasharray: `${100 - quota.fiveHour.usedPercent} 100` }"
        :d="quotaArc('left')"
      />
      <path
        class="quota-ring__arc"
        :class="`level-${quotaUsageLevel(quota.weekly.usedPercent)}`"
        pathLength="100"
        :style="{ strokeDasharray: `${100 - quota.weekly.usedPercent} 100` }"
        :d="quotaArc('right')"
      />
    </svg>
    <span
      class="context-ring__inner"
      :class="[ring && `level-${ring.level}`, { 'has-ring': ring, overflow: ring?.overflow }]"
    >
      <svg v-if="ring" class="context-ring__arc" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
        <circle class="context-ring__track" :cx="size / 2" :cy="size / 2" :r="ringRadius" />
        <circle
          class="context-ring__fill"
          :cx="size / 2"
          :cy="size / 2"
          :r="ringRadius"
          pathLength="100"
          :style="{ strokeDasharray: `${ring.fill * 100} 100` }"
        />
      </svg>
      <span class="context-ring__dot" :style="{ background: getActivityColor(activityLevel) }" />
    </span>
    <Teleport to="body">
      <div v-if="cardAt" class="context-card" :style="{ top: `${cardAt.top}px`, left: `${cardAt.left}px` }">
        <div class="context-card__head">{{ sessionContextUsageTitle(contextUsage) }}</div>
        <ContextSparkline
          v-if="hasGraph"
          :samples="contextHistory"
          :window="contextUsage?.window"
          :limits="limits"
          :width="280"
          :height="90"
          detailed
        />
        <div v-for="row in quotaRows" :key="row.label" class="quota-row" :class="`level-${row.level}`">
          <span class="quota-row__label">{{ row.label }}</span>
          <span class="quota-row__bar"><span class="quota-row__fill" :style="{ width: `${row.leftPercent}%` }" /></span>
          <span class="quota-row__pct">{{ row.leftPercent }}%</span>
          <span v-if="row.resetIn" class="quota-row__reset">{{ row.resetIn }}</span>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.context-ring {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: var(--indicator-size);
  height: var(--indicator-size);
}
.context-ring__inner {
  --ring-color: var(--accent);
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: var(--ring-size);
  height: var(--ring-size);
}
.context-ring__inner.level-warn { --ring-color: var(--status-blocked); }
.context-ring__inner.level-hot { --ring-color: var(--danger); }
.quota-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.quota-ring__track,
.quota-ring__arc {
  fill: none;
  stroke-width: var(--ring-thickness);
  stroke-linecap: butt;
}
.quota-ring__track { stroke: var(--border); }
.quota-ring__arc, .quota-row { --quota-color: var(--accent); stroke: var(--quota-color); }
.quota-ring__arc.level-warn, .quota-row.level-warn { --quota-color: var(--status-blocked); }
.quota-ring__arc.level-hot, .quota-row.level-hot { --quota-color: var(--danger); }
.context-ring__arc {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* Start the fill at twelve o'clock, like the phone. */
  transform: rotate(-90deg);
}
.context-ring__track,
.context-ring__fill {
  fill: none;
  stroke-width: var(--ring-thickness);
}
.context-ring__track { stroke: var(--border); }
.context-ring__fill { stroke: var(--ring-color); }
.context-ring__dot {
  width: var(--dot-size);
  height: var(--dot-size);
  border-radius: 50%;
}
/* Past the circle: the ring heartbeats; reduce-motion keeps a static halo instead. */
.context-ring__inner.overflow { animation: context-heartbeat 1.1s infinite; border-radius: 50%; }
@keyframes context-heartbeat {
  0%, 60%, 100% { transform: scale(1); box-shadow: 0 0 0 0 transparent; }
  10% { transform: scale(1.2); box-shadow: 0 0 6px 1px var(--danger); }
  22% { transform: scale(1); }
  34% { transform: scale(1.14); box-shadow: 0 0 4px 1px var(--danger); }
}
@media (prefers-reduced-motion: reduce) {
  .context-ring__inner.overflow { animation: none; box-shadow: 0 0 5px 1px var(--danger); }
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
.quota-row {
  display: grid;
  grid-template-columns: 34px 1fr 34px;
  gap: 2px var(--spacing-xs);
  align-items: center;
  margin-top: var(--spacing-xs);
  font-size: var(--font-size-xs);
}
.quota-row__label, .quota-row__reset { color: var(--text-secondary); }
.quota-row__pct { text-align: right; font-variant-numeric: tabular-nums; }
.quota-row__bar { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.quota-row__fill { display: block; height: 100%; border-radius: 3px; background: var(--quota-color); }
.quota-row__reset { grid-column: 2 / 4; }
</style>
