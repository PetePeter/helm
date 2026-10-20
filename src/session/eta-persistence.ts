/**
 * Append-only JSONL log of finished ETA estimates (`estimates.jsonl`). A torn
 * or hand-edited line costs only itself.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { isRecord } from './persistence-utils.js';
import type { EtaRecord } from './eta-tracker.js';

const FILE = 'estimates.jsonl';

function isEtaRecord(v: unknown): v is EtaRecord {
  return isRecord(v)
    && typeof v.startedAt === 'number'
    && typeof v.endedAt === 'number'
    && typeof v.firstAt === 'number'
    && typeof v.finalAt === 'number'
    && (v.outcome === 'cleared' || v.outcome === 'unmarked' || v.outcome === 'rescoped')
    && typeof v.cliType === 'string'
    && typeof v.dir === 'string'
    && typeof v.sessionName === 'string';
}

export class EtaPersistence {
  constructor(private readonly dir: string) {}

  append(record: EtaRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, FILE), JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      logger.error(`[EtaTracker] Failed to append estimate: ${err}`);
    }
  }

  loadAll(): EtaRecord[] {
    const file = join(this.dir, FILE);
    if (!existsSync(file)) return [];
    const records: EtaRecord[] = [];
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec: unknown = JSON.parse(line);
          if (isEtaRecord(rec)) records.push(rec);
        } catch {
          // Skip the bad line, keep the rest.
        }
      }
    } catch (err) {
      logger.error(`[EtaTracker] Failed to read ${file}: ${err}`);
    }
    return records;
  }
}
