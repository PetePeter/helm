/**
 * Persistence for the closed-session recycle bin.
 *
 * YAML shape { entries, pendingPurges } written via atomicWriteFileSync. The
 * state loader retains expired entries so startup can durably queue cleanup;
 * loadRecycleBin keeps the older filtered read behavior for callers that need it.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { RecycleBinEntry, RecycleBinPurgeJob } from '../types/recycle-bin.js';
import { atomicWriteFileSync, isRecord } from './persistence-utils.js';

/** Retention window: entries older than this (by closedAt) leave the visible list. */
export const RECYCLE_BIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecycleBinState {
  entries: RecycleBinEntry[];
  pendingPurges: RecycleBinPurgeJob[];
}

export function saveRecycleBin(
  entries: RecycleBinEntry[],
  filePath?: string,
  pendingPurges: RecycleBinPurgeJob[] = [],
  requireDurable = false,
): boolean {
  if (!filePath) return true;
  try {
    atomicWriteFileSync(filePath, YAML.stringify({ entries, pendingPurges }));
    return true;
  } catch (err) {
    logger.error(`Failed to save recycle bin: ${err}`);
    if (requireDurable) throw err;
    return false;
  }
}

export function loadRecycleBin(filePath?: string): RecycleBinEntry[] {
  const cutoff = Date.now() - RECYCLE_BIN_WINDOW_MS;
  return loadRecycleBinState(filePath).entries.filter(entry => entry.closedAt >= cutoff);
}

export function loadRecycleBinState(filePath?: string): RecycleBinState {
  const empty = (): RecycleBinState => ({ entries: [], pendingPurges: [] });
  if (!filePath) return empty();
  try {
    if (!existsSync(filePath)) return empty();
    const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return empty();

    const entries = parsed.entries.filter(isRecycleBinEntry);
    const pendingPurges = Array.isArray(parsed.pendingPurges)
      ? parsed.pendingPurges.filter(isRecycleBinPurgeJob)
      : [];
    return { entries, pendingPurges };
  } catch (err) {
    logger.error(`Failed to load recycle bin: ${err}`);
    return empty();
  }
}

function isRecycleBinEntry(value: unknown): value is RecycleBinEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.closedAt === 'number'
    && typeof value.cliSessionName === 'string'
    && value.cliSessionName.length > 0;
}

function isRecycleBinPurgeJob(value: unknown): value is RecycleBinPurgeJob {
  return isRecord(value)
    && isRecycleBinEntry(value.entry)
    && (value.kind === 'expired' || value.kind === 'forgotten');
}
