<script setup lang="ts">
/**
 * EstimatesView — the Statistics pane's Estimates tab: how the LLMs' ETAs
 * compared with when they actually cleared them (docs/session-eta.md).
 */
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
  ScatterController,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { EstimateView } from '../../../src/session/eta-stats.js';
import type { TimesheetPeriod } from '../../../src/session/time-tracker.js';
import { timeClient } from '../../ipc/clients.js';
import { readStatsChartTheme } from '../charts/stats-chart-config.js';
import { buildRatioConfig, buildScatterConfig, buildTrendConfig, type EstimateChartTheme } from '../charts/estimate-chart-config.js';
import EmptyState from '../common/EmptyState.vue';

Chart.register(BarController, BarElement, CategoryScale, Legend, LinearScale, LineController, LineElement, PointElement, ScatterController, Tooltip);

const props = defineProps<{ period: TimesheetPeriod; anchor: number }>();
const REFRESH_MS = 60_000;

const view = ref<EstimateView | null>(null);
const dir = ref('');
const host = ref<HTMLElement | null>(null);
const scatterCanvas = ref<HTMLCanvasElement | null>(null);
const ratioCanvas = ref<HTMLCanvasElement | null>(null);
const trendCanvas = ref<HTMLCanvasElement | null>(null);
const charts: Chart[] = [];

let generation = 0;
async function refresh(): Promise<void> {
  const ticket = ++generation;
  const next = await timeClient.timeEstimates(props.period, props.anchor, dir.value || null);
  if (ticket === generation) view.value = next;
}

function readTheme(el: HTMLElement): EstimateChartTheme {
  const base = readStatsChartTheme(el);
  const styles = getComputedStyle(el);
  return {
    ...base,
    accent: styles.getPropertyValue('--accent').trim() || base.text,
    warning: styles.getPropertyValue('--warning').trim() || '#b58900',
  };
}

function render(): void {
  charts.splice(0).forEach(chart => chart.destroy());
  const v = view.value;
  if (!v?.summary.total || !host.value) return;
  const theme = readTheme(host.value);
  const targets: [HTMLCanvasElement | null, ChartConfiguration][] = [
    [scatterCanvas.value, buildScatterConfig(v, theme)],
    [ratioCanvas.value, buildRatioConfig(v, theme)],
    [trendCanvas.value, buildTrendConfig(v, theme)],
  ];
  for (const [canvas, config] of targets) if (canvas) charts.push(new Chart(canvas, config));
}

const signed = (m: number): string => (m > 0 ? `+${m}m` : m < 0 ? `−${-m}m` : '0m');

watch(() => [props.period, props.anchor, dir.value], () => { void refresh(); }, { immediate: true });
watch(view, render, { flush: 'post' });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { void refresh(); }, REFRESH_MS); });
onBeforeUnmount(() => {
  clearInterval(timer);
  charts.forEach(chart => chart.destroy());
});
</script>

<template>
  <div ref="host" class="timesheet-scroll estimates">
    <EmptyState v-if="!view" title="Loading estimates" loading />
    <template v-else>
      <label v-if="view.dirs.length > 1 || dir" class="estimates-filter">
        Folder
        <select v-model="dir">
          <option value="">All folders</option>
          <option v-for="d in view.dirs" :key="d" :value="d">{{ d }}</option>
        </select>
      </label>
      <EmptyState v-if="!view.summary.total" title="No estimates in this period" />
      <template v-else>
        <div class="estimates-tiles">
          <div class="estimates-tile">On time<b class="estimates-good">{{ view.summary.onTimePct }}%</b></div>
          <div class="estimates-tile">Median slip<b>{{ signed(view.summary.medianSlipMin) }}</b></div>
          <div class="estimates-tile">Estimates<b>{{ view.summary.total }}</b></div>
          <div class="estimates-tile">Unmarked<b class="estimates-late">{{ view.summary.unmarked }}</b></div>
          <div class="estimates-tile">Rescoped<b>{{ view.summary.rescoped }}</b></div>
        </div>
        <div class="estimates-grid">
          <figure>
            <figcaption>Predicted vs actual</figcaption>
            <div class="estimates-chart"><canvas ref="scatterCanvas" aria-label="Predicted vs actual minutes" /></div>
          </figure>
          <figure>
            <figcaption>Actual ÷ predicted</figcaption>
            <div class="estimates-chart"><canvas ref="ratioCanvas" aria-label="Estimate ratio histogram" /></div>
          </figure>
          <figure class="estimates-wide">
            <figcaption>On time %</figcaption>
            <div class="estimates-chart estimates-chart--short"><canvas ref="trendCanvas" aria-label="On-time percentage" /></div>
          </figure>
        </div>
        <table class="timesheet-table">
          <thead><tr><th>Session</th><th>Note</th><th>Predicted</th><th>Actual</th><th>Δ</th></tr></thead>
          <tbody>
            <tr v-for="(row, i) in view.recent" :key="i">
              <td>{{ row.sessionName }}</td>
              <td class="estimates-note" :title="row.note">{{ row.note ?? '' }}</td>
              <td>{{ row.predictedMin }}m</td>
              <td>{{ row.actualMin }}m{{ row.outcome === 'unmarked' ? '+' : '' }}</td>
              <td v-if="row.outcome === 'rescoped'">rescoped</td>
              <td v-else :class="row.outcome === 'unmarked' || row.slipMin > 0 ? 'estimates-late' : 'estimates-good'">
                {{ row.outcome === 'unmarked' ? 'unmarked' : signed(row.slipMin) }}
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>
  </div>
</template>

<style scoped>
.timesheet-scroll { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-sm) var(--spacing-md); }
.timesheet-table { border-collapse: collapse; font-size: var(--font-size-sm); }
.timesheet-table th, .timesheet-table td { padding: var(--spacing-xs) var(--spacing-sm); border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.timesheet-table th:first-child, .timesheet-table td:first-child { text-align: left; }
.timesheet-table th { color: var(--text-secondary); font-weight: normal; position: sticky; top: 0; background: var(--bg-primary); }
.estimates-filter { display: inline-flex; gap: var(--spacing-sm); align-items: center; margin-bottom: var(--spacing-sm); font-size: var(--font-size-sm); color: var(--text-secondary); }
.estimates-filter select { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px var(--spacing-xs); font: inherit; }
.estimates-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--spacing-sm); max-width: 720px; margin-bottom: var(--spacing-md); }
.estimates-tile { background: var(--bg-tertiary); border-radius: var(--radius-sm); padding: var(--spacing-sm); color: var(--text-secondary); font-size: var(--font-size-sm); }
.estimates-tile b { display: block; margin-top: var(--spacing-xs); color: var(--text-primary); font-size: var(--font-size-lg); }
.estimates-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); max-width: 960px; margin-bottom: var(--spacing-md); }
.estimates-grid figure { margin: 0; min-width: 0; }
.estimates-grid figcaption { color: var(--text-secondary); font-size: var(--font-size-sm); margin-bottom: var(--spacing-xs); }
.estimates-wide { grid-column: 1 / -1; }
.estimates-chart { position: relative; height: 240px; }
.estimates-chart--short { height: 160px; }
.estimates .estimates-good { color: var(--accent); }
.estimates .estimates-late { color: var(--warning, #b58900); }
.estimates-note { max-width: 240px; overflow: hidden; text-overflow: ellipsis; text-align: left !important; }
</style>
