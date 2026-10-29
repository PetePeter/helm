import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Draft, DraftSend } from '../types/draft.js';
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
  const historyDir = join(dir, 'history');
  const listFiles = (directory: string): string[] => existsSync(directory)
    ? readdirSync(directory).filter(name => name.endsWith(EXTENSION)).flatMap(sessionIdOf)
    : [];
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
        rmSync(fileFor(historyDir, sessionId), { force: true });
      } catch (err) {
        logger.error(`[Draft] Failed to delete the draft of ${sessionId}: ${err}`);
      }
    },
    list() {
      try {
        return [...new Set([...listFiles(dir), ...listFiles(historyDir)])];
      } catch (err) {
        logger.error(`[Draft] Failed to list drafts: ${err}`);
        return [];
      }
    },
    loadHistory(sessionId) {
      try {
        const file = fileFor(historyDir, sessionId);
        if (!existsSync(file)) return [];
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter((item): item is DraftSend =>
          isRecord(item) && isAnyString(item.text) && isNumber(item.at)
          && (item.via === 'cli' || item.via === 'chat')).slice(0, 10);
      } catch (err) {
        logger.error(`[Draft] Failed to load send history of ${sessionId}: ${err}`);
        return [];
      }
    },
    saveHistory(sessionId, entries) {
      try {
        atomicWriteFileSync(fileFor(historyDir, sessionId), JSON.stringify(entries));
      } catch (err) {
        logger.error(`[Draft] Failed to save send history of ${sessionId}: ${err}`);
      }
    },
  };
}
