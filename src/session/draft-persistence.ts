import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Draft } from '../types/draft.js';
import type { DraftStore } from './draft-manager.js';
import { DRAFTS_DIR } from './persistence-paths.js';
import { atomicWriteFileSync, isAnyString, isNumber, isRecord } from './persistence-utils.js';

const EXTENSION = '.json';

/** Session ids are UUIDs today; encoding keeps any future id shape from naming a path. */
function fileFor(dir: string, sessionId: string): string {
  const name = encodeURIComponent(sessionId);
  if (!name || /^\.+$/.test(name)) throw new Error(`Invalid session id for a draft: "${sessionId}"`);
  return join(dir, `${name}${EXTENSION}`);
}

/** A file this store did not write (a name that does not decode) is skipped, not allowed to hide the rest. */
function sessionIdOf(fileName: string): string[] {
  try {
    return [decodeURIComponent(fileName.slice(0, -EXTENSION.length))];
  } catch {
    logger.warn(`[Draft] Ignoring a file that is not a draft: ${fileName}`);
    return [];
  }
}

function parse(sessionId: string, raw: unknown): Draft | null {
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
 * Drafts were once called scratchpads, and `drafts.yaml` / `prompt-templates.yaml`
 * held two features that are gone. Carry the pads over under their new name and
 * delete the dead files, so nothing stale is left behind in the config dir.
 */
export function migrateLegacyDraftStore(configDir: string): void {
  const legacyDir = join(configDir, 'scratchpads');
  const dir = join(configDir, 'drafts');
  try {
    if (existsSync(legacyDir) && !existsSync(dir)) renameSync(legacyDir, dir);
    for (const dead of ['drafts.yaml', 'prompt-templates.yaml']) rmSync(join(configDir, dead), { force: true });
  } catch (error) {
    logger.error(`[Draft] Legacy store migration failed: ${error}`);
  }
}

/**
 * One JSON file per session under the user config dir. Errors are logged, never
 * thrown: a pad that cannot be saved must not break the session it belongs to.
 */
export function createDraftStore(dir: string = DRAFTS_DIR): DraftStore {
  return {
    load(sessionId) {
      try {
        const file = fileFor(dir, sessionId);
        return existsSync(file) ? parse(sessionId, JSON.parse(readFileSync(file, 'utf8'))) : null;
      } catch (err) {
        logger.error(`[Draft] Failed to load the draft of ${sessionId}: ${err}`);
        return null;
      }
    },
    save(draft) {
      try {
        const { sessionId, ...body } = draft;
        atomicWriteFileSync(fileFor(dir, sessionId), JSON.stringify(body));
      } catch (err) {
        logger.error(`[Draft] Failed to save the draft of ${draft.sessionId}: ${err}`);
      }
    },
    remove(sessionId) {
      try {
        rmSync(fileFor(dir, sessionId), { force: true });
      } catch (err) {
        logger.error(`[Draft] Failed to delete the draft of ${sessionId}: ${err}`);
      }
    },
    list() {
      try {
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .filter(name => name.endsWith(EXTENSION))
          .flatMap(name => sessionIdOf(name));
      } catch (err) {
        logger.error(`[Draft] Failed to list drafts: ${err}`);
        return [];
      }
    },
  };
}
