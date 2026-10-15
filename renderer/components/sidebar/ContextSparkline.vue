<script setup lang="ts">
import { computed } from 'vue';
import type { ContextUsageSample } from '../../../src/types/session.js';
import { sparklineGeometry } from '../../context-sparkline.js';
import { contextLevel, type ContextLimits } from '../../../src/session/context-limits.js';

const props = withDefaults(defineProps<{
  samples?: ContextUsageSample[];
  window?: number;
  /** Amber/red token counts for this session's CLI type (see context-limits.ts). */
  limits?: ContextLimits;
  width?: number;
  height?: number;
  /** Large variant: dashed limit line plus faint amber / red guides. */
  detailed?: boolean;
}>(), { width: 48, height: 14, detailed: false });

const pad = computed(() => (props.detailed ? 4 : 2));
const geometry = computed(() => sparklineGeometry(props.samples, props.window, {
  width: props.width - pad.value * 2,
  height: props.height - pad.value * 2,
}));
const level = computed(() => {
  const last = props.samples?.at(-1);
  return last ? contextLevel(last.tokens, props.limits) : 'ok';
});
const guides = computed(() => (props.detailed && props.window && props.limits
  ? [props.limits.amber, props.limits.red]
    .map((tokens) => Math.min(tokens / props.window!, 1))
    .map((fill) => ({ fill, y: (props.height - pad.value * 2) * (1 - fill) }))
  : []));
</script>

<template>
  <svg
    v-if="geometry"
    class="context-sparkline"
    :class="`level-${level}`"
    :width="width"
    :height="height"
    :viewBox="`${-pad} ${-pad} ${width} ${height}`"
    aria-hidden="true"
  >
    <template v-if="detailed && window">
      <line class="limit" x1="0" :x2="width - pad * 2" y1="0" y2="0" />
      <line v-for="g in guides" :key="g.fill" class="guide" x1="0" :x2="width - pad * 2" :y1="g.y" :y2="g.y" />
    </template>
    <path class="area" :d="geometry.area" />
    <path class="line" :d="geometry.line" />
    <circle class="now" :cx="geometry.points.at(-1)!.x" :cy="geometry.points.at(-1)!.y" :r="detailed ? 3 : 1.8" />
  </svg>
</template>

<style scoped>
.context-sparkline { flex: 0 0 auto; overflow: visible; --fill: var(--accent); }
.context-sparkline.level-warn { --fill: var(--status-blocked); }
.context-sparkline.level-hot { --fill: var(--danger); }
.area { fill: var(--fill); fill-opacity: 0.22; }
.line { fill: none; stroke: var(--fill); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.now { fill: var(--fill); }
.limit { stroke: var(--text-dim); stroke-dasharray: 4 4; }
.guide { stroke: var(--text-dim); stroke-opacity: 0.5; }
</style>
