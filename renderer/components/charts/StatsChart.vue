<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import type { ChartModel } from '../../../src/session/chart-model.js';
import { buildStatsChartConfig, readStatsChartTheme, type StatsChartKind } from './stats-chart-config.js';

Chart.register(BarController, BarElement, CategoryScale, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip);

const props = defineProps<{ model: ChartModel; kind: StatsChartKind }>();
const host = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

function renderChart(): void {
  if (!host.value || !canvas.value || !props.model.labels.length || !props.model.series.length) {
    chart?.destroy();
    chart = null;
    return;
  }
  const config = buildStatsChartConfig(props.model, props.kind, readStatsChartTheme(host.value));
  if (chart) {
    chart.data = config.data;
    chart.options = config.options ?? {};
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}

watch(() => [props.model, props.kind], renderChart, { deep: true });
onMounted(renderChart);
onBeforeUnmount(() => chart?.destroy());
</script>

<template>
  <div ref="host" class="stats-chart">
    <canvas v-if="model.labels.length && model.series.length" ref="canvas" :aria-label="kind === 'tokens' ? 'Tokens per CLI' : 'Time and tokens'" />
    <p v-else class="stats-chart-empty">No chart data</p>
  </div>
</template>

<style scoped>
.stats-chart { position: relative; width: 100%; height: 250px; min-width: 0; }
.stats-chart canvas { display: block; max-width: 100%; }
.stats-chart-empty { margin: 0; color: var(--text-secondary); }
</style>
