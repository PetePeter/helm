import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { ScheduledTask } from '../types/scheduled-task.js';
import { atomicWriteFileSync, isRecord, isString } from './persistence-utils.js';

export function saveScheduledTasks(tasks: ScheduledTask[], filePath?: string): void {
  if (!filePath) return;
  try {
    const data = {
      tasks: tasks.map(t => ({
        ...t,
        scheduledTime: t.scheduledTime.toISOString(),
        ...(t.nextRunAt ? { nextRunAt: t.nextRunAt.toISOString() } : {}),
        ...(t.endDate ? { endDate: t.endDate.toISOString() } : {}),
      })),
    };
    atomicWriteFileSync(filePath, YAML.stringify(data));
  } catch (err) {
    logger.error(`Failed to save scheduled tasks: ${err}`);
  }
}

export function loadScheduledTasks(filePath?: string): ScheduledTask[] {
  if (!filePath) return [];
  try {
    if (!existsSync(filePath)) return [];
    const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks
      .filter((task): task is Record<string, unknown> => isRecord(task) && isString(task.scheduledTime))
      .map(task => ({
        ...(task as any),
        scheduledTime: new Date(task.scheduledTime as string),
        ...(typeof task.nextRunAt === 'string' ? { nextRunAt: new Date(task.nextRunAt) } : {}),
        ...(typeof task.endDate === 'string' ? { endDate: new Date(task.endDate) } : {}),
      }));
  } catch (err) {
    logger.error(`Failed to load scheduled tasks: ${err}`);
    return [];
  }
}
