/**
 * Persistence for runtime session groups.
 *
 * Mirrors recycle-bin-persistence: YAML shape { groups: [...] } written via
 * atomicWriteFileSync. On load, entries that are not structurally valid
 * RuntimeGroups are defensively dropped so a hand-edited or corrupt file can
 * never crash startup.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import { normalizeRuntimeGroupColor, type RuntimeGroup } from '../types/runtime-group.js';
import { atomicWriteFileSync, isRecord } from './persistence-utils.js';

export function saveRuntimeGroups(groups: RuntimeGroup[], filePath?: string): void {
  if (!filePath) return;
  try {
    atomicWriteFileSync(filePath, YAML.stringify({ groups }));
  } catch (err) {
    logger.error(`Failed to save runtime groups: ${err}`);
  }
}

export function loadRuntimeGroups(filePath?: string): RuntimeGroup[] {
  if (!filePath) return [];
  try {
    if (!existsSync(filePath)) return [];
    const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.groups)) return [];

    return parsed.groups
      .filter((g): g is RuntimeGroup =>
        isRecord(g) &&
        typeof g.id === 'string' && g.id.length > 0 &&
        typeof g.name === 'string' &&
        Array.isArray(g.sessionIds))
      // A retired palette colour maps to its successor; anything else outside
      // the palette (hand-edited, or a newer build's) falls back to the default
      // rather than costing the group.
      .map(({ color, ...group }) => {
        const known = normalizeRuntimeGroupColor(color);
        return known ? { ...group, color: known } : group;
      });
  } catch (err) {
    logger.error(`Failed to load runtime groups: ${err}`);
    return [];
  }
}
