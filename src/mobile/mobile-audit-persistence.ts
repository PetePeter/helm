/**
 * Persistence for the mobile audit log — the ONE place mobile-audit.yaml is
 * read and written.
 *
 * Mirrors peer-audit-persistence exactly: YAML shape `{ entries: [...] }` via
 * atomicWriteFileSync at mode 0600 (an audit trail should not be world-readable),
 * and a defensive prune on load so a long-dormant file cannot resurrect stale
 * entries or grow unbounded. Separate file from the fleet's: a phone and a peer
 * have different lifetimes, and revoking one must never disturb the other.
 *
 * SECURITY: entries carry NO payload values and NO secrets by construction — the
 * gate records argument KEY NAMES and an error TYPE only. This module never adds
 * anything back.
 *
 * The file path is a parameter (defaulting to MOBILE_AUDIT_FILE) purely so tests
 * can round-trip against a temp file.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import { MOBILE_AUDIT_FILE } from '../session/persistence-paths.js';
import { atomicWriteFileSync, isRecord } from '../session/persistence-utils.js';
import type { MobileAuditEntry } from './mobile-audit-log.js';

/** Retention window: entries older than this (by ranAt) are discarded. */
export const MOBILE_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function saveMobileAudit(entries: MobileAuditEntry[], file: string = MOBILE_AUDIT_FILE): void {
  try {
    atomicWriteFileSync(file, YAML.stringify({ entries }), { mode: 0o600 });
  } catch (err) {
    logger.error(`[mobile-audit] Failed to save mobile audit log: ${(err as Error).message}`);
  }
}

export function loadMobileAudit(
  file: string = MOBILE_AUDIT_FILE,
  now: number = Date.now(),
): MobileAuditEntry[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = YAML.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];

    const cutoff = now - MOBILE_AUDIT_WINDOW_MS;
    return parsed.entries.filter(
      (e): e is MobileAuditEntry =>
        isRecord(e) && typeof e.ranAt === 'number' && e.ranAt >= cutoff,
    );
  } catch (err) {
    logger.error(`[mobile-audit] Failed to load mobile audit log: ${(err as Error).message}`);
    return [];
  }
}
