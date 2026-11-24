import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  USER_TASK_ATTACHMENTS_MAX,
  USER_TASK_ATTACHMENT_MAX_BYTES,
  USER_TASK_BODY_MAX,
  USER_TASK_CHECKLIST_ITEM_MAX,
  USER_TASK_CHECKLIST_MAX,
  USER_TASK_DONE_RETENTION_MS,
  USER_TASK_TITLE_MAX,
  type UserTask,
  type UserTaskAttachment,
  type UserTaskAttachmentInput,
  type UserTaskAuthor,
  type UserTaskChecklistItem,
  type UserTaskChecklistItemInput,
  type UserTaskInput,
  type UserTaskPatch,
  type UserTasksChanged,
} from '../types/user-task.js';

/** Persistence is injected so tests and other profiles each get their own store. */
export interface UserTaskStore {
  load(): UserTask[];
  save(tasks: UserTask[]): void;
  writeAttachment(taskId: string, attachmentId: string, content: Buffer): void;
  readAttachment(taskId: string, attachmentId: string): Buffer;
  removeAttachments(taskId: string): void;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new Error('title is required');
  if (title.length > USER_TASK_TITLE_MAX) throw new Error(`title exceeds ${USER_TASK_TITLE_MAX} characters`);
  return title;
}

function cleanBody(value: unknown): string {
  const body = typeof value === 'string' ? value.trim() : '';
  if (body.length > USER_TASK_BODY_MAX) throw new Error(`body exceeds ${USER_TASK_BODY_MAX} characters`);
  return body;
}

function cleanProject(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function copy(task: UserTask): UserTask {
  return {
    ...task,
    author: { ...task.author },
    attachments: task.attachments.map(a => ({ ...a })),
    checklist: task.checklist.map(i => ({ ...i })),
  };
}

/** Urgent first, then newest; done tasks sink below every open one. */
function compare(a: UserTask, b: UserTask): number {
  const doneDelta = Number(a.doneAt !== undefined) - Number(b.doneAt !== undefined);
  if (doneDelta) return doneDelta;
  const urgentDelta = Number(b.urgent) - Number(a.urgent);
  if (urgentDelta) return urgentDelta;
  return b.createdAt - a.createdAt;
}

/** The profile's one board of things for the user to do. Mutations persist immediately. */
export class UserTaskManager extends EventEmitter {
  private tasks: UserTask[];

  constructor(
    private readonly store: UserTaskStore,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.tasks = store.load();
    if (this.purgeExpired()) this.store.save(this.tasks);
  }

  list(): UserTask[] {
    if (this.purgeExpired()) this.persist();
    return [...this.tasks].sort(compare).map(copy);
  }

  get(id: string): UserTask {
    return copy(this.find(id));
  }

  /** Tick or untick one item. Never completes the task: closing it stays the user's call. */
  check(taskId: string, itemId: string, done: boolean): UserTask {
    const current = this.find(taskId);
    if (!current.checklist.some(i => i.id === itemId)) throw new Error(`Checklist item not found: ${itemId}`);
    const at = this.now();
    const next: UserTask = {
      ...current,
      checklist: current.checklist.map(item => item.id !== itemId ? item : done
        ? { ...item, doneAt: item.doneAt ?? at }
        : { id: item.id, text: item.text }),
      updatedAt: at,
    };
    this.tasks = this.tasks.map(task => task.id === taskId ? next : task);
    this.persist();
    return copy(next);
  }

  add(input: UserTaskInput, author: UserTaskAuthor, attachments: UserTaskAttachmentInput[] = []): UserTask {
    const title = cleanTitle(input.title);
    const body = cleanBody(input.body);
    const at = this.now();
    const checklist = this.buildChecklist(input.checklist ?? [], [], at);
    if (attachments.length > USER_TASK_ATTACHMENTS_MAX) {
      throw new Error(`a task holds at most ${USER_TASK_ATTACHMENTS_MAX} attachments`);
    }
    for (const a of attachments) {
      if (!Buffer.isBuffer(a.content)) throw new Error('attachment content must be bytes');
      if (a.content.byteLength > USER_TASK_ATTACHMENT_MAX_BYTES) throw new Error(`attachment "${a.title}" exceeds 10MB`);
    }
    const id = this.uniqueId();
    const stored: UserTaskAttachment[] = [];
    try {
      for (const a of attachments) {
        const attachmentId = this.createId();
        this.store.writeAttachment(id, attachmentId, a.content);
        stored.push({
          id: attachmentId,
          kind: a.kind,
          title: a.title.trim() || a.kind,
          contentType: a.contentType,
          sizeBytes: a.content.byteLength,
          ...(a.planId ? { planId: a.planId } : {}),
          createdAt: at,
        });
      }
    } catch (error) {
      this.store.removeAttachments(id);
      throw error;
    }
    const projectId = cleanProject(input.projectId);
    const task: UserTask = {
      id,
      title,
      body,
      author: { ...author },
      ...(projectId ? { projectId } : {}),
      urgent: input.urgent === true,
      attachments: stored,
      checklist,
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.push(task);
    this.persist();
    return copy(task);
  }

  update(id: string, patch: UserTaskPatch): UserTask {
    const current = this.find(id);
    const next: UserTask = { ...current };
    if (patch.title !== undefined) next.title = cleanTitle(patch.title);
    if (patch.body !== undefined) next.body = cleanBody(patch.body);
    if (patch.urgent !== undefined) next.urgent = patch.urgent === true;
    if (patch.projectId !== undefined) {
      const projectId = cleanProject(patch.projectId);
      if (projectId) next.projectId = projectId;
      else delete next.projectId;
    }
    const at = this.now();
    if (patch.checklist !== undefined) next.checklist = this.buildChecklist(patch.checklist, current.checklist, at);
    if (patch.done === true && next.doneAt === undefined) next.doneAt = at;
    if (patch.done === false) delete next.doneAt;
    next.updatedAt = at;
    this.tasks = this.tasks.map(task => task.id === id ? next : task);
    this.persist();
    return copy(next);
  }

  delete(id: string): void {
    this.find(id);
    this.tasks = this.tasks.filter(task => task.id !== id);
    this.store.removeAttachments(id);
    this.persist();
  }

  readAttachment(taskId: string, attachmentId: string): { attachment: UserTaskAttachment; content: Buffer } {
    const attachment = this.find(taskId).attachments.find(a => a.id === attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    return { attachment: { ...attachment }, content: this.store.readAttachment(taskId, attachmentId) };
  }

  openCount(): number {
    return this.tasks.filter(task => task.doneAt === undefined).length;
  }

  private find(id: string): UserTask {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw new Error(`User task not found: ${id}`);
    return task;
  }

  /** A row naming a known id keeps that item's tick unless it says `done` itself. */
  private buildChecklist(input: UserTaskChecklistItemInput[], previous: UserTaskChecklistItem[], at: number): UserTaskChecklistItem[] {
    if (!Array.isArray(input)) throw new Error('checklist must be a list');
    if (input.length > USER_TASK_CHECKLIST_MAX) throw new Error(`a checklist holds at most ${USER_TASK_CHECKLIST_MAX} items`);
    const used = new Set<string>();
    return input.map(row => {
      const text = typeof row?.text === 'string' ? row.text.trim() : '';
      if (!text) throw new Error('checklist item text is required');
      if (text.length > USER_TASK_CHECKLIST_ITEM_MAX) throw new Error(`checklist item exceeds ${USER_TASK_CHECKLIST_ITEM_MAX} characters`);
      const known = row.id && !used.has(row.id) ? previous.find(i => i.id === row.id) : undefined;
      const id = known?.id ?? this.freshItemId(previous, used);
      used.add(id);
      const done = row.done ?? known?.doneAt !== undefined;
      return done ? { id, text, doneAt: known?.doneAt ?? at } : { id, text };
    });
  }

  private freshItemId(previous: UserTaskChecklistItem[], used: Set<string>): string {
    let id = this.createId();
    while (used.has(id) || previous.some(i => i.id === id)) id = this.createId();
    return id;
  }

  private uniqueId(): string {
    let id = this.createId();
    while (this.tasks.some(t => t.id === id)) id = this.createId();
    return id;
  }

  private purgeExpired(): boolean {
    const cutoff = this.now() - USER_TASK_DONE_RETENTION_MS;
    const expired = this.tasks.filter(t => t.doneAt !== undefined && t.doneAt < cutoff);
    if (!expired.length) return false;
    for (const task of expired) this.store.removeAttachments(task.id);
    this.tasks = this.tasks.filter(t => !expired.includes(t));
    return true;
  }

  private persist(): void {
    this.store.save(this.tasks);
    const event: UserTasksChanged = { tasks: [...this.tasks].sort(compare).map(copy) };
    this.emit('userTasks:changed', event);
  }
}
