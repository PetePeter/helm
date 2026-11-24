/**
 * A User Task is work only the USER can do — decide, test, approve, buy —
 * posted by the user or by any AI session. Tasks outlive the session that wrote
 * them, so the author and every attachment are snapshots owned by the task.
 */

/** Who wrote the task. An AI author is a snapshot: its session may since be gone. */
export type UserTaskAuthor =
  | { kind: 'user' }
  | { kind: 'ai'; name: string; cliType?: string; dir?: string; sessionId?: string };

export type UserTaskAttachmentKind = 'artifact' | 'plan' | 'file';

/** Metadata of one owned copy; the bytes live beside the task store. */
export interface UserTaskAttachment {
  id: string;
  kind: UserTaskAttachmentKind;
  title: string;
  contentType: string;
  sizeBytes: number;
  /** Plans only: the live plan this snapshot was taken from, if it still exists. */
  planId?: string;
  createdAt: number;
}

/** One tickable step of a task. Order is the author's; ticking never reorders. */
export interface UserTaskChecklistItem {
  id: string;
  text: string;
  /** Set while ticked. */
  doneAt?: number;
}

/** A checklist row as written: a known id keeps that item's tick unless `done` says otherwise. */
export interface UserTaskChecklistItemInput {
  id?: string;
  text: string;
  done?: boolean;
}

export interface UserTask {
  id: string;
  title: string;
  body: string;
  author: UserTaskAuthor;
  /** Optional: no project shows under "General". */
  projectId?: string;
  urgent: boolean;
  attachments: UserTaskAttachment[];
  checklist: UserTaskChecklistItem[];
  createdAt: number;
  updatedAt: number;
  /** Set while done; done tasks are purged after USER_TASK_DONE_RETENTION_MS. */
  doneAt?: number;
}

export interface UserTaskAttachmentInput {
  kind: UserTaskAttachmentKind;
  title: string;
  contentType: string;
  content: Buffer;
  planId?: string;
}

export interface UserTaskInput {
  title: string;
  body?: string;
  projectId?: string;
  urgent?: boolean;
  checklist?: UserTaskChecklistItemInput[];
}

export interface UserTaskPatch {
  title?: string;
  body?: string;
  /** null clears the project. */
  projectId?: string | null;
  urgent?: boolean;
  done?: boolean;
  /** Replaces the whole checklist. */
  checklist?: UserTaskChecklistItemInput[];
}

export interface UserTasksChanged {
  tasks: UserTask[];
}

export const USER_TASK_DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const USER_TASK_TITLE_MAX = 200;
export const USER_TASK_BODY_MAX = 4000;
export const USER_TASK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const USER_TASK_ATTACHMENTS_MAX = 10;
export const USER_TASK_CHECKLIST_MAX = 50;
export const USER_TASK_CHECKLIST_ITEM_MAX = 200;
