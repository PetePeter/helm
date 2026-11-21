/**
 * Quota history survives a restart so the burn graph and rate do not start
 * over. Only percentages and timestamps under the opaque scope hash are kept.
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync, isNumber, isRecord } from './persistence-utils.js';
import type { QuotaHistoryPoint } from './quota-burn.js';
import { logger } from '../utils/logger.js';

export interface QuotaHistoryStore {
  load(): Map<string, QuotaHistoryPoint[]>;
  save(histories: ReadonlyMap<string, readonly QuotaHistoryPoint[]>): void;
}

export function createQuotaHistoryStore(filePath: string): QuotaHistoryStore {
  return {
    load() {
      const result = new Map<string, QuotaHistoryPoint[]>();
      if (!existsSync(filePath)) return result;
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!isRecord(raw)) return result;
        for (const [scope, points] of Object.entries(raw)) {
          if (!Array.isArray(points)) continue;
          const valid = points.filter((p): p is QuotaHistoryPoint =>
            isRecord(p) && isNumber(p.at) && isNumber(p.fiveHour) && isNumber(p.weekly));
          if (valid.length) result.set(scope, valid);
        }
      } catch (error) {
        logger.warn(`[QuotaHistory] Ignoring unreadable ${filePath}: ${String(error)}`);
      }
      return result;
    },
    save(histories) {
      try {
        atomicWriteFileSync(filePath, JSON.stringify(Object.fromEntries(histories)));
      } catch (error) {
        logger.warn(`[QuotaHistory] Could not save ${filePath}: ${String(error)}`);
      }
    },
  };
}
