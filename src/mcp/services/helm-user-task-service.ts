import { readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { isMobileSessionId } from '../../mobile/mobile-identity.js';
import type { UserTaskManager } from '../../session/user-task-manager.js';
import type { Artifact } from '../../types/artifact.js';
import type { PlanItem } from '../../types/plan.js';
import {
  USER_TASK_ATTACHMENT_MAX_BYTES,
  type UserTask,
  type UserTaskAttachmentInput,
  type UserTaskAuthor,
  type UserTaskChecklistItemInput,
  type UserTaskPatch,
} from '../../types/user-task.js';

/** What an AI asks to attach. Each becomes a copy the task owns. */
export type UserTaskAttachRequest =
  | { artifactId: string }
  | { planId: string }
  | { filePath: string };

export interface UserTaskCaller {
  sessionId?: string;
  sessionName?: string;
}

export interface UserTaskServiceDeps {
  manager: UserTaskManager;
  getSession(id: string): { id: string; name: string; cliType?: string; workingDir?: string; projectId?: string } | undefined;
  findProjectIdByPath(dir: string): string | undefined;
  projectExists(projectId: string): boolean;
  getArtifact(id: string): Artifact | null;
  getPlan(id: string): PlanItem | null;
}

/** A compact board row: enough to choose, never the attachment bytes. */
export interface UserTaskRow {
  id: string;
  title: string;
  urgent: boolean;
  projectId?: string;
  author: string;
  /** First line(s) of the body, enough for a 2-line preview on a note. */
  excerpt?: string;
  attachments: number;
  /** Present when the task has a checklist. */
  checklist?: { done: number; total: number };
  createdAt: number;
  doneAt?: number;
}

const TEXT_TYPES: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function isTextContentType(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType === 'application/json';
}

const USER_TASK_EXCERPT_MAX = 140;

function authorLabel(author: UserTaskAuthor): string {
  return author.kind === 'user' ? 'you' : author.name;
}

function toRow(task: UserTask): UserTaskRow {
  return {
    id: task.id,
    title: task.title,
    urgent: task.urgent,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    author: authorLabel(task.author),
    ...(task.body ? { excerpt: task.body.slice(0, USER_TASK_EXCERPT_MAX) } : {}),
    attachments: task.attachments.length,
    ...(task.checklist.length ? { checklist: { done: task.checklist.filter(i => i.doneAt !== undefined).length, total: task.checklist.length } } : {}),
    createdAt: task.createdAt,
    ...(task.doneAt !== undefined ? { doneAt: task.doneAt } : {}),
  };
}

function planMarkdown(plan: PlanItem): string {
  const lines = [`# ${plan.humanId ? `${plan.humanId} ` : ''}${plan.title}`, '', `Status: ${plan.status}`];
  if (plan.stateInfo) lines.push('', plan.stateInfo);
  if (plan.description) lines.push('', plan.description);
  if (plan.completionNotes) lines.push('', '## Completion notes', '', plan.completionNotes);
  return lines.join('\n');
}

/**
 * The user_task_* MCP surface. AI callers are recorded as a snapshot of their
 * session; a paired phone (mobile:<deviceId>) IS the user. Identity comes from
 * the authenticated caller, never from arguments, so no AI can post as "you".
 */
export class HelmUserTaskService {
  constructor(private readonly deps: UserTaskServiceDeps) {}

  add(
    caller: UserTaskCaller,
    input: {
      title: string;
      body?: string;
      urgent?: boolean;
      projectId?: string;
      checklist?: UserTaskChecklistItemInput[];
      attach?: UserTaskAttachRequest[];
    },
  ): UserTaskRow {
    const author = this.authorFor(caller);
    const projectId = input.projectId !== undefined ? this.requireProject(input.projectId) : this.projectFor(caller);
    const attachments = (input.attach ?? []).map(request => this.snapshot(caller, request));
    const task = this.deps.manager.add(
      { title: input.title, body: input.body, urgent: input.urgent, projectId, checklist: input.checklist },
      author,
      attachments,
    );
    return toRow(task);
  }

  list(options: { includeDone?: boolean; projectId?: string } = {}): UserTaskRow[] {
    return this.deps.manager.list()
      .filter(task => options.includeDone || task.doneAt === undefined)
      .filter(task => options.projectId === undefined || (task.projectId ?? '') === options.projectId)
      .map(toRow);
  }

  /** The full task, or one attachment's content (utf8 for text, base64 otherwise). */
  get(id: string, attachmentId?: string): UserTask | { attachment: UserTask['attachments'][number]; encoding: 'utf8' | 'base64'; content: string } {
    if (!attachmentId) return this.deps.manager.get(id);
    const { attachment, content } = this.deps.manager.readAttachment(id, attachmentId);
    const text = isTextContentType(attachment.contentType);
    return { attachment, encoding: text ? 'utf8' : 'base64', content: content.toString(text ? 'utf8' : 'base64') };
  }

  update(id: string, patch: UserTaskPatch): UserTaskRow {
    const clean: UserTaskPatch = { ...patch };
    if (typeof clean.projectId === 'string') clean.projectId = this.requireProject(clean.projectId);
    return toRow(this.deps.manager.update(id, clean));
  }

  done(id: string, done = true): UserTaskRow {
    return toRow(this.deps.manager.update(id, { done }));
  }

  /** Returns the full task so the caller sees every item's id and tick. */
  check(id: string, itemId: string, done = true): UserTask {
    return this.deps.manager.check(id, itemId, done);
  }

  delete(id: string): { deleted: true; id: string } {
    this.deps.manager.delete(id);
    return { deleted: true, id };
  }

  private authorFor(caller: UserTaskCaller): UserTaskAuthor {
    if (isMobileSessionId(caller.sessionId)) return { kind: 'user' };
    const session = caller.sessionId ? this.deps.getSession(caller.sessionId) : undefined;
    if (session && session.id === caller.sessionId) {
      return {
        kind: 'ai',
        name: session.name,
        ...(session.cliType ? { cliType: session.cliType } : {}),
        ...(session.workingDir ? { dir: session.workingDir } : {}),
        sessionId: session.id,
      };
    }
    return { kind: 'ai', name: caller.sessionName || caller.sessionId || 'unknown' };
  }

  private projectFor(caller: UserTaskCaller): string | undefined {
    if (!caller.sessionId || isMobileSessionId(caller.sessionId)) return undefined;
    const session = this.deps.getSession(caller.sessionId);
    if (!session || session.id !== caller.sessionId) return undefined;
    if (session.projectId && this.deps.projectExists(session.projectId)) return session.projectId;
    return session.workingDir ? this.deps.findProjectIdByPath(session.workingDir) : undefined;
  }

  private requireProject(projectId: string): string | undefined {
    if (!projectId.trim()) return undefined;
    if (!this.deps.projectExists(projectId)) throw new Error(`Project not found: ${projectId}`);
    return projectId;
  }

  private snapshot(caller: UserTaskCaller, request: UserTaskAttachRequest): UserTaskAttachmentInput {
    if ('artifactId' in request) {
      const artifact = this.deps.getArtifact(request.artifactId);
      // An AI attaches its own work; the phone (the user) may attach any.
      const mayRead = artifact && (isMobileSessionId(caller.sessionId) || artifact.sessionId === caller.sessionId);
      if (!artifact || !mayRead) throw new Error(`Artifact not found: ${request.artifactId}`);
      const latest = artifact.versions[artifact.versions.length - 1];
      return {
        kind: 'artifact',
        title: artifact.title,
        contentType: artifact.kind === 'html' ? 'text/html' : artifact.kind === 'markdown' ? 'text/markdown' : 'text/plain',
        content: Buffer.from(latest?.content ?? '', 'utf8'),
      };
    }
    if ('planId' in request) {
      const plan = this.deps.getPlan(request.planId);
      if (!plan) throw new Error(`Plan not found: ${request.planId}`);
      return {
        kind: 'plan',
        title: plan.humanId ? `${plan.humanId} ${plan.title}` : plan.title,
        contentType: 'text/markdown',
        content: Buffer.from(planMarkdown(plan), 'utf8'),
        planId: plan.id,
      };
    }
    if ('filePath' in request) {
      if (isMobileSessionId(caller.sessionId)) throw new Error('A phone cannot attach desktop files');
      const filePath = request.filePath;
      if (!isAbsolute(filePath)) throw new Error('filePath must be an absolute path');
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error('filePath must point to a regular file');
      if (stat.size > USER_TASK_ATTACHMENT_MAX_BYTES) throw new Error('File exceeds 10MB size limit');
      return {
        kind: 'file',
        title: basename(filePath),
        contentType: TEXT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        content: readFileSync(filePath),
      };
    }
    throw new Error('each attach item needs artifactId, planId or filePath');
  }
}
