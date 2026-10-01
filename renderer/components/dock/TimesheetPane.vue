<script setup lang="ts">
/**
 * TimesheetPane — time worked on the active session's project, per folder,
 * by hour / day / week / month. "You" is the user's own time; "AI" is when
 * the project's agents were busy. See docs/time-tracking.md.
 */
import { computed } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import PanelHeader from '../common/PanelHeader.vue';
import type { TimesheetPeriod } from '../../../src/session/time-tracker.js';
import { columnLabel, formatMinutes, useTimesheetPane } from '../../composables/useTimesheetPane.js';

const PERIODS: { id: TimesheetPeriod; label: string }[] = [
  { id: 'hour', label: 'Hour' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

const { project, period, anchor, sheet, step, exportCsv } = useTimesheetPane();

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const range = computed(() => {
  const d = new Date(anchor.value);
  if (period.value === 'hour') return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  if (period.value === 'month') return String(d.getFullYear());
  if (period.value === 'week') return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const cols = sheet.value?.columns ?? [];
  if (!cols.length) return '';
  const fmt = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${fmt(cols[0])} – ${fmt(cols[cols.length - 1])}`;
});
</script>

<template>
  <section class="timesheet-pane" aria-label="Project timesheet">
    <PanelHeader title="Timesheet" icon="⏱" :subtitle="project?.name ?? 'No active project'">
      <template #toolbar>
        <div class="timesheet-toolbar">
          <div class="timesheet-toggle" role="group" aria-label="View">
            <button
              v-for="p in PERIODS"
              :key="p.id"
              type="button"
              :class="{ 'is-active': period === p.id }"
              @click="period = p.id"
            >{{ p.label }}</button>
          </div>
          <button type="button" aria-label="Previous" @click="step(-1)">◀</button>
          <button type="button" @click="step(0)">{{ range }}</button>
          <button type="button" aria-label="Next" @click="step(1)">▶</button>
          <button type="button" :disabled="!sheet?.rows.length" @click="exportCsv">⬇ CSV</button>
        </div>
      </template>
    </PanelHeader>

    <EmptyState v-if="!project" title="No active project" hint="Select a session to see its project's timesheet." icon="⏱" />
    <EmptyState v-else-if="!sheet" title="Loading timesheet" loading />
    <EmptyState v-else-if="!sheet.rows.length" title="No time recorded" hint="Time is counted in 5-minute slots while you work in this project's sessions." icon="⏱" />
    <div v-else class="timesheet-scroll">
      <table class="timesheet-table">
        <thead>
          <tr>
            <th>Folder</th>
            <th v-for="col in sheet.columns" :key="col">{{ columnLabel(period, col) }}</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sheet.rows" :key="row.dir">
            <td class="timesheet-dir" :title="row.dir">{{ row.dir }}</td>
            <td v-for="(_, i) in sheet.columns" :key="i">
              <span class="timesheet-you">{{ formatMinutes(row.user[i]) }}</span>
              <span v-if="row.ai[i]" class="timesheet-ai">AI {{ formatMinutes(row.ai[i]) }}</span>
            </td>
            <td>
              <span class="timesheet-you">{{ formatMinutes(sum(row.user)) }}</span>
              <span class="timesheet-ai">AI {{ formatMinutes(sum(row.ai)) }}</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td v-for="(_, i) in sheet.columns" :key="i">
              <span class="timesheet-you">{{ formatMinutes(sheet.totals.user[i]) }}</span>
              <span v-if="sheet.totals.ai[i]" class="timesheet-ai">AI {{ formatMinutes(sheet.totals.ai[i]) }}</span>
            </td>
            <td>
              <span class="timesheet-you">{{ formatMinutes(sum(sheet.totals.user)) }}</span>
              <span class="timesheet-ai">AI {{ formatMinutes(sum(sheet.totals.ai)) }}</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
</template>

<style scoped>
.timesheet-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.timesheet-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-sm); font-size: var(--font-size-sm); }
.timesheet-toolbar button { padding: 3px var(--spacing-sm); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-primary); }
.timesheet-toolbar button:hover:not(:disabled) { background: var(--bg-hover); }
.timesheet-toolbar button:disabled { color: var(--text-dim); }
.timesheet-toggle { display: inline-flex; gap: 2px; }
.timesheet-toggle .is-active { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast); }
.timesheet-toggle .is-active:hover { background: var(--accent-hover); }
.timesheet-scroll { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-sm) var(--spacing-md); }
.timesheet-table { border-collapse: collapse; font-size: var(--font-size-sm); }
.timesheet-table th, .timesheet-table td { padding: var(--spacing-xs) var(--spacing-sm); border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; vertical-align: top; }
.timesheet-table th:first-child, .timesheet-table td:first-child { text-align: left; }
.timesheet-table th { color: var(--text-secondary); font-weight: normal; position: sticky; top: 0; background: var(--bg-primary); }
.timesheet-table tfoot td { font-weight: 600; border-top: 1px solid var(--border); }
.timesheet-dir { font-family: var(--font-mono); max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
.timesheet-you { display: block; color: var(--text-primary); }
.timesheet-ai { display: block; color: var(--info); font-size: var(--font-size-xs); }
</style>
