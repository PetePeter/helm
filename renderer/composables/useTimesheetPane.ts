/**
 * Timesheet pane state: the active session's project, a period view, and an
 * anchor date to page through. All arithmetic lives in the main process
 * (time-tracker.ts); this only asks for a sheet and refreshes it.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { Timesheet, TimesheetPeriod } from '../../src/session/time-tracker.js';
import { timeClient } from '../ipc/clients.js';
import { useAppStore } from '../stores/app.js';

const REFRESH_MS = 60_000;

export function useTimesheetPane() {
  const appStore = useAppStore();
  const period = ref<TimesheetPeriod>('day');
  const anchor = ref(Date.now());
  const sheet = ref<Timesheet | null>(null);

  /** Same key the tracker credits: the Helm project id, else the session's directory. */
  const project = computed(() => {
    const session = appStore.activeSession;
    if (!session) return null;
    const record = session.projectId ? appStore.state.projects.find(p => p.id === session.projectId) : undefined;
    if (record) return { key: record.id, name: record.name };
    return session.workingDir ? { key: session.workingDir, name: session.workingDir } : null;
  });

  let generation = 0;
  async function refresh(): Promise<void> {
    const target = project.value;
    const ticket = ++generation;
    if (!target) { sheet.value = null; return; }
    const next = await timeClient.timeTimesheet(target.key, period.value, anchor.value);
    if (ticket === generation) sheet.value = next;
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
    const target = project.value;
    if (!target) return;
    const csv = await timeClient.timeCsv(target.key, period.value, anchor.value, target.name);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheet-${target.name.replace(/[^\w.-]+/g, '_')}-${period.value}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  watch([() => project.value?.key, period, anchor], () => { void refresh(); }, { immediate: true });
  const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  onUnmounted(() => clearInterval(timer));

  return { project, period, anchor, sheet, step, exportCsv };
}

/** Column heading for a view. */
export function columnLabel(period: TimesheetPeriod, start: number): string {
  const d = new Date(start);
  if (period === 'hour') return `${String(d.getHours()).padStart(2, '0')}:00`;
  if (period === 'day') return d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  if (period === 'week') return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { month: 'short' });
}

/** Minutes as "3h05"; zero renders as an en dash. */
export function formatMinutes(minutes: number): string {
  if (!minutes) return '–';
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}
