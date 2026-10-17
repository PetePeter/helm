import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { SessionTodo } from '../types/todo.js';
import type { TodoStore } from './todo-manager.js';
import { TODOS_DIR } from './persistence-paths.js';
import { atomicWriteFileSync, isNumber, isRecord, isString } from './persistence-utils.js';

const EXTENSION = '.json';

function fileFor(dir: string, sessionId: string): string {
  const name = encodeURIComponent(sessionId);
  if (!name || /^\.+$/.test(name)) throw new Error(`Invalid session id for todos: "${sessionId}"`);
  return join(dir, `${name}${EXTENSION}`);
}

function sessionIdOf(fileName: string): string[] {
  try {
    return [decodeURIComponent(fileName.slice(0, -EXTENSION.length))];
  } catch {
    logger.warn(`[Todos] Ignoring a file with an invalid session id: ${fileName}`);
    return [];
  }
}

function parseTodo(raw: unknown): SessionTodo | null {
  if (!isRecord(raw) || !isString(raw.id) || !isString(raw.text) || !isNumber(raw.createdAt)) return null;
  if (raw.status !== 'open' && raw.status !== 'done') return null;
  return {
    id: raw.id,
    text: raw.text,
    status: raw.status,
    createdAt: raw.createdAt,
    ...(isNumber(raw.doneAt) ? { doneAt: raw.doneAt } : {}),
  };
}

function parse(raw: unknown): SessionTodo[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap(item => {
    const todo = parseTodo(item);
    return todo ? [todo] : [];
  });
}

/** One atomic JSON file per session under the app config directory. */
export function createTodoStore(dir: string = TODOS_DIR): TodoStore {
  return {
    load(sessionId) {
      try {
        const file = fileFor(dir, sessionId);
        return existsSync(file) ? parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
      } catch (error) {
        logger.error(`[Todos] Failed to load todos for ${sessionId}: ${error}`);
        return null;
      }
    },
    save(sessionId, todos) {
      try {
        atomicWriteFileSync(fileFor(dir, sessionId), JSON.stringify(todos));
      } catch (error) {
        logger.error(`[Todos] Failed to save todos for ${sessionId}: ${error}`);
      }
    },
    remove(sessionId) {
      try {
        rmSync(fileFor(dir, sessionId), { force: true });
      } catch (error) {
        logger.error(`[Todos] Failed to delete todos for ${sessionId}: ${error}`);
      }
    },
    list() {
      try {
        if (!existsSync(dir)) return [];
        return readdirSync(dir).filter(name => name.endsWith(EXTENSION)).flatMap(sessionIdOf);
      } catch (error) {
        logger.error(`[Todos] Failed to list todo files: ${error}`);
        return [];
      }
    },
  };
}
