import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { UserTask, UserTaskAttachment, UserTaskAuthor } from '../types/user-task.js';
import type { UserTaskStore } from './user-task-manager.js';
import { atomicWriteFileSync, isNumber, isRecord, isString } from './persistence-utils.js';

const TASKS_FILE = 'tasks.json';
const ATTACHMENTS_DIR = 'attachments';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeId(value: string, what: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${what} id: "${value}"`);
  return value;
}

function parseAuthor(raw: unknown): UserTaskAuthor | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'user') return { kind: 'user' };
  if (raw.kind !== 'ai' || !isString(raw.name)) return null;
  return {
    kind: 'ai',
    name: raw.name,
    ...(isString(raw.cliType) ? { cliType: raw.cliType } : {}),
    ...(isString(raw.dir) ? { dir: raw.dir } : {}),
    ...(isString(raw.sessionId) ? { sessionId: raw.sessionId } : {}),
  };
}

function parseAttachment(raw: unknown): UserTaskAttachment | null {
  if (!isRecord(raw) || !isString(raw.id) || !isString(raw.title) || !isString(raw.contentType)) return null;
  if (raw.kind !== 'artifact' && raw.kind !== 'plan' && raw.kind !== 'file') return null;
  if (!isNumber(raw.sizeBytes) || !isNumber(raw.createdAt) || !SAFE_ID.test(raw.id)) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title,
    contentType: raw.contentType,
    sizeBytes: raw.sizeBytes,
    ...(isString(raw.planId) ? { planId: raw.planId } : {}),
    createdAt: raw.createdAt,
  };
}

function parseTask(raw: unknown): UserTask | null {
  if (!isRecord(raw) || !isString(raw.id) || !SAFE_ID.test(raw.id) || !isString(raw.title)) return null;
  if (!isNumber(raw.createdAt) || !isNumber(raw.updatedAt)) return null;
  const author = parseAuthor(raw.author);
  if (!author) return null;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.flatMap(item => { const a = parseAttachment(item); return a ? [a] : []; })
    : [];
  return {
    id: raw.id,
    title: raw.title,
    body: isString(raw.body) ? raw.body : '',
    author,
    ...(isString(raw.projectId) ? { projectId: raw.projectId } : {}),
    urgent: raw.urgent === true,
    attachments,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(isNumber(raw.doneAt) ? { doneAt: raw.doneAt } : {}),
  };
}

/** One atomic JSON index plus one folder of owned attachment bytes per task. */
export function createUserTaskStore(dir: string): UserTaskStore {
  const tasksFile = join(dir, TASKS_FILE);
  const taskDir = (taskId: string) => join(dir, ATTACHMENTS_DIR, safeId(taskId, 'task'));
  return {
    load() {
      try {
        if (!existsSync(tasksFile)) return [];
        const raw: unknown = JSON.parse(readFileSync(tasksFile, 'utf8'));
        if (!Array.isArray(raw)) return [];
        return raw.flatMap(item => { const t = parseTask(item); return t ? [t] : []; });
      } catch (error) {
        logger.error(`[UserTasks] Failed to load tasks: ${error}`);
        return [];
      }
    },
    save(tasks) {
      try {
        mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      } catch (error) {
        logger.error(`[UserTasks] Failed to save tasks: ${error}`);
      }
    },
    writeAttachment(taskId, attachmentId, content) {
      const folder = taskDir(taskId);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, safeId(attachmentId, 'attachment')), content);
    },
    readAttachment(taskId, attachmentId) {
      return readFileSync(join(taskDir(taskId), safeId(attachmentId, 'attachment')));
    },
    removeAttachments(taskId) {
      try {
        rmSync(taskDir(taskId), { recursive: true, force: true });
      } catch (error) {
        logger.error(`[UserTasks] Failed to delete attachments of ${taskId}: ${error}`);
      }
    },
  };
}
