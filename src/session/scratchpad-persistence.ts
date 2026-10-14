import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Scratchpad } from '../types/scratchpad.js';
import type { ScratchpadStore } from './scratchpad-manager.js';
import { SCRATCHPADS_DIR } from './persistence-paths.js';
import { atomicWriteFileSync, isAnyString, isNumber, isRecord } from './persistence-utils.js';

const EXTENSION = '.json';

/** Session ids are UUIDs today; encoding keeps any future id shape from naming a path. */
function fileFor(dir: string, sessionId: string): string {
  const name = encodeURIComponent(sessionId);
  if (!name || /^\.+$/.test(name)) throw new Error(`Invalid session id for a scratchpad: "${sessionId}"`);
  return join(dir, `${name}${EXTENSION}`);
}

/** A file this store did not write (a name that does not decode) is skipped, not allowed to hide the rest. */
function sessionIdOf(fileName: string): string[] {
  try {
    return [decodeURIComponent(fileName.slice(0, -EXTENSION.length))];
  } catch {
    logger.warn(`[Scratchpad] Ignoring a file that is not a scratchpad: ${fileName}`);
    return [];
  }
}

function parse(sessionId: string, raw: unknown): Scratchpad | null {
  if (!isRecord(raw) || !isAnyString(raw.text) || !isNumber(raw.revision) || raw.revision < 1) return null;
  return {
    sessionId,
    text: raw.text,
    revision: raw.revision,
    ...(isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.updatedBy === 'user' || raw.updatedBy === 'ai' ? { updatedBy: raw.updatedBy } : {}),
  };
}

/**
 * One JSON file per session under the user config dir. Errors are logged, never
 * thrown: a pad that cannot be saved must not break the session it belongs to.
 */
export function createScratchpadStore(dir: string = SCRATCHPADS_DIR): ScratchpadStore {
  return {
    load(sessionId) {
      try {
        const file = fileFor(dir, sessionId);
        return existsSync(file) ? parse(sessionId, JSON.parse(readFileSync(file, 'utf8'))) : null;
      } catch (err) {
        logger.error(`[Scratchpad] Failed to load the scratchpad of ${sessionId}: ${err}`);
        return null;
      }
    },
    save(scratchpad) {
      try {
        const { sessionId, ...body } = scratchpad;
        atomicWriteFileSync(fileFor(dir, sessionId), JSON.stringify(body));
      } catch (err) {
        logger.error(`[Scratchpad] Failed to save the scratchpad of ${scratchpad.sessionId}: ${err}`);
      }
    },
    remove(sessionId) {
      try {
        rmSync(fileFor(dir, sessionId), { force: true });
      } catch (err) {
        logger.error(`[Scratchpad] Failed to delete the scratchpad of ${sessionId}: ${err}`);
      }
    },
    list() {
      try {
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .filter(name => name.endsWith(EXTENSION))
          .flatMap(name => sessionIdOf(name));
      } catch (err) {
        logger.error(`[Scratchpad] Failed to list scratchpads: ${err}`);
        return [];
      }
    },
  };
}
