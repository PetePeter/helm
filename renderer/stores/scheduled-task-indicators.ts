import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { eventsClient, schedulerClient } from '../ipc/clients.js';
import type { ScheduledTask } from '../../src/types/scheduled-task.js';

function buildTooltips(tasks: readonly ScheduledTask[]): Map<string, string> {
  const nearestBySession = new Map<string, { task: ScheduledTask; nextRunAt: Date }>();
  for (const task of tasks) {
    const sessionId = task.targetSessionId;
    if (task.status !== 'pending' || task.mode !== 'direct' || !sessionId
      || task.scheduleKind === 'none' || task.enabled === false) continue;

    const nextRunAt = new Date(task.nextRunAt ?? task.scheduledTime);
    if (!Number.isFinite(nextRunAt.getTime())) continue;
    const current = nearestBySession.get(sessionId);
    if (!current || nextRunAt.getTime() < current.nextRunAt.getTime()) {
      nearestBySession.set(sessionId, { task, nextRunAt });
    }
  }

  const tooltips = new Map<string, string>();
  for (const [sessionId, { task, nextRunAt }] of nearestBySession) {
    tooltips.set(sessionId, `Scheduled task: ${task.title}  next ${nextRunAt.toLocaleString()}`);
  }
  return tooltips;
}

export const useScheduledTaskIndicatorsStore = defineStore('scheduled-task-indicators', () => {
  const tooltips = reactive(new Map<string, string>());
  let consumers = 0;
  let loadVersion = 0;
  let offChanged: (() => void) | null = null;

  function replaceTooltips(next: Map<string, string>): void {
    for (const sessionId of tooltips.keys()) {
      if (!next.has(sessionId)) tooltips.delete(sessionId);
    }
    for (const [sessionId, tooltip] of next) {
      if (tooltips.get(sessionId) !== tooltip) tooltips.set(sessionId, tooltip);
    }
  }

  async function refresh(): Promise<void> {
    const version = ++loadVersion;
    const load = schedulerClient.scheduledTaskList;
    if (typeof load !== 'function') {
      replaceTooltips(new Map());
      return;
    }

    try {
      const tasks = await load() as ScheduledTask[] | null | undefined;
      if (version === loadVersion) replaceTooltips(buildTooltips(tasks ?? []));
    } catch {
      if (version === loadVersion) replaceTooltips(new Map());
    }
  }

  function start(): void {
    consumers++;
    if (consumers !== 1) return;
    offChanged = eventsClient.onScheduledTaskChanged?.(() => { void refresh(); }) ?? null;
    void refresh();
  }

  function stop(): void {
    if (consumers === 0) return;
    consumers--;
    if (consumers > 0) return;
    loadVersion++;
    offChanged?.();
    offChanged = null;
    replaceTooltips(new Map());
  }

  function tooltipFor(sessionId: string): string | null {
    return tooltips.get(sessionId) ?? null;
  }

  return { tooltips, start, stop, tooltipFor };
});
