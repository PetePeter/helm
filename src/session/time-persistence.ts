/**
 * Append-only JSONL store for time-tracking slots, one file per local month
 * (`YYYY-MM.jsonl`). Appending keeps a crash from losing more than the open
 * slot; a corrupt line is skipped rather than costing the whole month.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { isRecord } from './persistence-utils.js';
import type { TimeSlot } from './time-tracker.js';

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isSlot(v: unknown): v is TimeSlot {
  return isRecord(v)
    && typeof v.start === 'number'
    && (v.kind === 'user' || v.kind === 'ai')
    && typeof v.projectKey === 'string'
    && typeof v.projectName === 'string'
    && typeof v.dir === 'string';
}

export class TimePersistence {
  constructor(private readonly dir: string) {}

  append(slots: TimeSlot[]): void {
    const byMonth = new Map<string, string>();
    for (const slot of slots) {
      const key = monthKey(slot.start);
      byMonth.set(key, (byMonth.get(key) ?? '') + JSON.stringify(slot) + '\n');
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const [key, text] of byMonth) appendFileSync(join(this.dir, `${key}.jsonl`), text, 'utf8');
    } catch (err) {
      logger.error(`[TimeTracking] Failed to append slots: ${err}`);
    }
  }

  /** Slots whose start falls in [from, to). */
  load(from: number, to: number): TimeSlot[] {
    const slots: TimeSlot[] = [];
    for (const key of monthsBetween(from, to)) {
      const file = join(this.dir, `${key}.jsonl`);
      if (!existsSync(file)) continue;
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const slot: unknown = JSON.parse(line);
            if (isSlot(slot) && slot.start >= from && slot.start < to) slots.push(slot);
          } catch {
            // A torn or hand-edited line costs only itself.
          }
        }
      } catch (err) {
        logger.error(`[TimeTracking] Failed to read ${file}: ${err}`);
      }
    }
    return slots;
  }
}

function monthsBetween(from: number, to: number): string[] {
  const keys: string[] = [];
  const d = new Date(from);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() < to) {
    keys.push(monthKey(d.getTime()));
    d.setMonth(d.getMonth() + 1);
  }
  return keys;
}
