/**
 * Statistics pane state. Timesheet tab: all-project totals with drilldown to
 * one project's folder grid. Tokens tab: tokens per configured CLI. Both share
 * the period and anchor. All arithmetic lives in the main process (time-tracker.ts).
 */
import { onUnmounted, ref, watch } from 'vue';
import type { ChartModel } from '../../src/session/chart-model.js';
import type { ProjectTotal, Timesheet, TimesheetPeriod, TokenSheet } from '../../src/session/time-tracker.js';
import { timeClient } from '../ipc/clients.js';

const REFRESH_MS = 60_000;

export type StatisticsTab = 'timesheet' | 'tokens';

export function useTimesheetPane() {
  const tab = ref<StatisticsTab>('timesheet');
  const period = ref<TimesheetPeriod>('day');
  const anchor = ref(Date.now());
  const sheet = ref<Timesheet | null>(null);
  const chartModel = ref<ChartModel | null>(null);
  const projects = ref<ProjectTotal[] | null>(null);
  const selectedProject = ref<ProjectTotal | null>(null);
  const tokenSheet = ref<TokenSheet | null>(null);

  let generation = 0;
  async function refresh(): Promise<void> {
    const target = selectedProject.value;
    const ticket = ++generation;
    if (tab.value === 'tokens') {
      const tokens = await timeClient.timeTokens(period.value, anchor.value);
      if (ticket !== generation) return;
      tokenSheet.value = tokens.sheet;
      chartModel.value = tokens.chartModel;
      return;
    }
    const next = await timeClient.timeQuery({
      period: period.value,
      anchor: anchor.value,
      projectKey: target?.projectKey,
    });
    if (ticket !== generation) return;
    chartModel.value = next.chartModel;
    if ('projects' in next) {
      projects.value = next.projects;
      sheet.value = null;
    } else {
      projects.value = null;
      sheet.value = next.sheet;
    }
  }

  function openProject(project: ProjectTotal): void {
    projects.value = null;
    sheet.value = null;
    selectedProject.value = project;
  }
  function backToProjects(): void {
    projects.value = null;
    sheet.value = null;
    selectedProject.value = null;
  }

  /** Move one view-width back (-1) or forward (+1); 0 returns to now. */
  function step(direction: -1 | 0 | 1): void {
    if (direction === 0) { anchor.value = Date.now(); return; }
    const d = new Date(anchor.value);
    if (period.value === 'hour') d.setDate(d.getDate() + direction);
    else if (period.value === 'day') d.setDate(d.getDate() + 7 * direction);
    else if (period.value === 'week') d.setMonth(d.getMonth() + direction);
    else d.setFullYear(d.getFullYear() + direction);
    anchor.value = d.getTime();
  }

  async function exportCsv(): Promise<void> {
    const target = selectedProject.value;
    if (!target) return;
    const csv = await timeClient.timeCsv(target.projectKey, period.value, anchor.value, target.projectName);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheet-${target.projectName.replace(/[^\w.-]+/g, '_')}-${period.value}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  watch([tab, () => selectedProject.value?.projectKey, period, anchor], () => { void refresh(); }, { immediate: true });
  const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  onUnmounted(() => clearInterval(timer));

  return { tab, tokenSheet, projects, selectedProject, period, anchor, sheet, chartModel, openProject, backToProjects, step, exportCsv };
}

/** Minutes as "3h05"; zero renders as an en dash. */
export function formatMinutes(minutes: number): string {
  if (!minutes) return '–';
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}
