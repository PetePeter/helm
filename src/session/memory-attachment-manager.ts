import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { getTempDir } from '../utils/app-paths.js';
import type {
  MemoryAttachment,
  MemoryAttachmentInput,
  MemoryAttachmentTempFile,
} from '../types/memory.js';
import { atomicWriteFileSync } from './persistence-utils.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const INDEX_FILE = 'index.json';
const DELETION_JOURNAL_FILE = 'deletion-journal.json';
const DELETION_TRASH_DIR = '.deletion-trash';
export const MEMORY_ATTACHMENT_TEMP_PREFIX = 'helm-memory-attachment-';

interface StoredMemoryAttachment extends MemoryAttachment {
  relativePath: string;
}

interface AttachmentIndex {
  version: 1;
  attachments: StoredMemoryAttachment[];
}

interface DeletionJournal {
  version: 1;
  transactionId: string;
  entries: DeletionJournalEntry[];
}

interface DeletionJournalEntry {
  attachment: MemoryAttachment;
  relativePath: string;
  trashRelativePath: string;
}

export interface MemoryAttachmentDeleteTransaction {
  readonly attachments: MemoryAttachment[];
  commitMetadata(): void;
  rollback(): void;
  finalize(): void;
}

export interface MemoryAttachmentManagerOptions {
  atomicWrite?: (filePath: string, content: string) => void;
  deleteFile?: (filePath: string) => void;
}

export interface MemoryAttachmentSnapshot {
  attachment: MemoryAttachment;
  content: Buffer;
}

export class MemoryAttachmentManager {
  private readonly indexPath: string;
  private readonly journalPath: string;
  private readonly tempDir: string;
  private readonly options: MemoryAttachmentManagerOptions;

  constructor(
    private readonly rootDir: string,
    tempDir: string = getTempDir(import.meta.dirname ?? '.'),
    options: MemoryAttachmentManagerOptions = {},
  ) {
    this.indexPath = join(rootDir, INDEX_FILE);
    this.journalPath = join(rootDir, DELETION_JOURNAL_FILE);
    this.tempDir = tempDir;
    this.options = options;
  }

  list(memoryId: string): MemoryAttachment[] {
    return this.loadIndex().attachments
      .filter((attachment) => attachment.memoryId === memoryId)
      .sort(compareAttachments)
      .map(toPublicAttachment);
  }

  get(memoryId: string, attachmentId: string): MemoryAttachment | null {
    const found = this.loadIndex().attachments.find(
      (attachment) => attachment.memoryId === memoryId && attachment.id === attachmentId,
    );
    return found ? toPublicAttachment(found) : null;
  }

  add(memoryId: string, input: MemoryAttachmentInput): MemoryAttachment {
    if (!Buffer.isBuffer(input.content)) throw new Error('Attachment content must be a Buffer');
    if (input.content.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds 10MB size limit');
    const safeFilename = sanitizeFilename(input.filename);
    const id = randomUUID();
    const storedFilename = `${id}${extname(safeFilename)}`;
    const storageDir = this.storageDir(memoryId);
    const storagePath = join(storageDir, storedFilename);
    let fileWritten = false;

    try {
      mkdirSync(storageDir, { recursive: true });
      this.assertInside(this.rootDir, storageDir);
      this.assertSafeExistingPath(storageDir);
      this.assertInside(storageDir, storagePath);
      writeFileSync(storagePath, input.content);
      fileWritten = true;

      const attachment: StoredMemoryAttachment = {
        id,
        memoryId,
        filename: safeFilename,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        sizeBytes: input.content.byteLength,
        sha256: createHash('sha256').update(input.content).digest('hex'),
        relativePath: `${encodeURIComponent(memoryId)}/${storedFilename}`,
        createdAt: Date.now(),
      };
      const index = this.loadIndex();
      index.attachments.push(attachment);
      this.saveIndex(index);
      return toPublicAttachment(attachment);
    } catch (error) {
      if (fileWritten) {
        try { unlinkSync(storagePath); } catch { /* best effort compensation */ }
      }
      try {
        if (existsSync(storageDir) && readdirSync(storageDir).length === 0) rmSync(storageDir, { recursive: true, force: true });
      } catch { /* best effort compensation */ }
      throw error;
    }
  }

  getToTempFile(attachment: MemoryAttachment): MemoryAttachmentTempFile;
  getToTempFile(memoryId: string, attachmentId: string): MemoryAttachmentTempFile;
  getToTempFile(
    attachmentOrMemoryId: MemoryAttachment | string,
    attachmentId?: string,
  ): MemoryAttachmentTempFile {
    const attachment = typeof attachmentOrMemoryId === 'string'
      ? this.get(attachmentOrMemoryId, attachmentId ?? '')
      : this.get(attachmentOrMemoryId.memoryId, attachmentOrMemoryId.id);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId ?? (typeof attachmentOrMemoryId === 'string' ? attachmentOrMemoryId : attachmentOrMemoryId.id)}`);

    const stored = this.loadIndex().attachments.find(
      (item) => item.memoryId === attachment.memoryId && item.id === attachment.id,
    );
    if (!stored) throw new Error(`Attachment not found: ${attachment.id}`);
    const sourcePath = this.absoluteStoragePath(stored);
    if (!existsSync(sourcePath)) throw new Error(`Attachment content missing: ${attachment.id}`);
    this.assertSafeExistingPath(sourcePath);

    mkdirSync(this.tempDir, { recursive: true });
    this.assertSafeTempDirectory();
    const tempPath = join(this.tempDir, `${MEMORY_ATTACHMENT_TEMP_PREFIX}${randomUUID()}-${sanitizeFilename(attachment.filename)}`);
    this.assertInside(this.tempDir, tempPath);
    this.assertSafeTempDestination(tempPath);
    writeFileSync(tempPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o600 });
    return { attachment: { ...attachment }, tempPath };
  }

  snapshot(memoryId: string, attachmentId: string): MemoryAttachmentSnapshot {
    const attachment = this.get(memoryId, attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    const stored = this.loadIndex().attachments.find(
      (item) => item.memoryId === memoryId && item.id === attachmentId,
    );
    if (!stored) throw new Error(`Attachment not found: ${attachmentId}`);
    const sourcePath = this.absoluteStoragePath(stored);
    if (!existsSync(sourcePath)) throw new Error(`Attachment content missing: ${attachmentId}`);
    this.assertSafeExistingPath(sourcePath);
    const content = readFileSync(sourcePath);
    if (content.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds 10MB size limit');
    return { attachment, content };
  }

  snapshotsForMemory(memoryId: string): MemoryAttachmentSnapshot[] {
    return this.list(memoryId).map((attachment) => this.snapshot(memoryId, attachment.id));
  }

  restore(snapshot: MemoryAttachmentSnapshot): void {
    const { attachment, content } = snapshot;
    if (content.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds 10MB size limit');
    const storageDir = this.storageDir(attachment.memoryId);
    const storedFilename = `${attachment.id}${extname(sanitizeFilename(attachment.filename))}`;
    const storagePath = join(storageDir, storedFilename);
    this.assertInside(this.rootDir, storageDir);
    this.assertInside(storageDir, storagePath);
    mkdirSync(storageDir, { recursive: true });
    this.assertSafeExistingPath(storageDir);
    if (existsSync(storagePath)) {
      this.assertSafeExistingPath(storagePath);
      const existing = readFileSync(storagePath);
      if (!existing.equals(content)) throw new Error(`Attachment restore collision: ${attachment.id}`);
    } else {
      writeFileSync(storagePath, content, { flag: 'wx', mode: 0o600 });
    }
    const index = this.loadIndex();
    if (!index.attachments.some((item) => item.id === attachment.id && item.memoryId === attachment.memoryId)) {
      index.attachments.push({
        ...attachment,
        relativePath: `${encodeURIComponent(attachment.memoryId)}/${storedFilename}`,
      });
      this.saveIndex(index);
    }
  }

  stageDelete(memoryId: string, attachmentId: string): MemoryAttachmentDeleteTransaction | null {
    const index = this.loadIndex();
    const found = index.attachments.find(
      (attachment) => attachment.memoryId === memoryId && attachment.id === attachmentId,
    );
    return found ? this.stageEntries([found]) : null;
  }

  stageDeleteForMemory(memoryId: string): MemoryAttachmentDeleteTransaction | null {
    const entries = this.loadIndex().attachments.filter((attachment) => attachment.memoryId === memoryId);
    return entries.length > 0 ? this.stageEntries(entries) : null;
  }

  stageDeleteForMemories(memoryIds: Set<string>): MemoryAttachmentDeleteTransaction | null {
    const entries = this.loadIndex().attachments.filter((attachment) => memoryIds.has(attachment.memoryId));
    return entries.length > 0 ? this.stageEntries(entries) : null;
  }

  delete(memoryId: string, attachmentId: string): boolean {
    const transaction = this.stageDelete(memoryId, attachmentId);
    if (!transaction) return false;
    try {
      transaction.commitMetadata();
      transaction.finalize();
    } catch (error) {
      try { transaction.rollback(); } catch (rollbackError) {
        throw new Error(`${String(error)}; attachment rollback failed: ${String(rollbackError)}`);
      }
      throw error;
    }
    return true;
  }

  deleteForMemory(memoryId: string): number {
    const transaction = this.stageDeleteForMemory(memoryId);
    if (!transaction) return 0;
    try {
      transaction.commitMetadata();
      transaction.finalize();
    } catch (error) {
      try { transaction.rollback(); } catch (rollbackError) {
        throw new Error(`${String(error)}; attachment rollback failed: ${String(rollbackError)}`);
      }
      throw error;
    }
    return transaction.attachments.length;
  }

  reconcile(liveState: { records: Array<{ id: string; attachments: MemoryAttachment[] }> }): void {
    const journal = this.loadJournal();
    if (!journal) return;
    const liveAttachments = new Set(
      liveState.records.flatMap((record) => record.attachments.map((attachment) => `${record.id}\u0000${attachment.id}`)),
    );
    const hasLiveAttachment = journal.entries.some(
      (entry) => liveAttachments.has(`${entry.attachment.memoryId}\u0000${entry.attachment.id}`),
    );
    if (hasLiveAttachment) {
      this.restoreJournal(journal);
    } else {
      this.finalizeJournal(journal);
    }
  }

  private stageEntries(entries: StoredMemoryAttachment[]): MemoryAttachmentDeleteTransaction {
    if (this.loadJournal()) throw new Error('Another memory attachment deletion is already in progress');

    const transactionId = randomUUID();
    const journal: DeletionJournal = {
      version: 1,
      transactionId,
      entries: entries.map((attachment) => ({
        attachment: toPublicAttachment(attachment),
        relativePath: attachment.relativePath,
        trashRelativePath: `${DELETION_TRASH_DIR}/${transactionId}/${attachment.id}${extname(sanitizeFilename(attachment.filename))}`,
      })),
    };
    this.saveJournal(journal);

    try {
      for (const entry of journal.entries) {
        const sourcePath = this.absoluteStoragePathFromRelative(entry.relativePath);
        const trashPath = this.absoluteStoragePathFromRelative(entry.trashRelativePath);
        if (!existsSync(sourcePath)) throw new Error(`Attachment content missing: ${entry.attachment.id}`);
        this.assertSafeExistingPath(sourcePath);
        this.assertInside(this.rootDir, trashPath);
        mkdirSync(join(this.rootDir, DELETION_TRASH_DIR, transactionId), { recursive: true });
        this.assertSafeExistingPath(join(this.rootDir, DELETION_TRASH_DIR));
        this.assertSafeExistingPath(join(this.rootDir, DELETION_TRASH_DIR, transactionId));
        if (this.options.deleteFile) {
          // Preserve the old injectable deletion seam while retaining a durable copy.
          writeFileSync(trashPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o600 });
          this.options.deleteFile(sourcePath);
          if (existsSync(sourcePath)) throw new Error(`Attachment delete hook did not remove: ${entry.attachment.id}`);
        } else {
          renameSync(sourcePath, trashPath);
        }
      }
    } catch (error) {
      try {
        this.restoreJournalFiles(journal, journal.entries);
        try { this.removeJournal(journal); } catch { /* the durable journal can be reconciled on startup */ }
      } catch (restoreError) {
        // Keep the journal when compensation is incomplete. It is the durable
        // source of truth for startup reconciliation; deleting it here could
        // strand trash bytes and lose the ability to recover them.
        throw new Error(`${String(error)}; attachment stage rollback requires reconciliation: ${String(restoreError)}`);
      }
      throw error;
    }

    let metadataRemoved = false;
    return {
      attachments: journal.entries.map((entry) => ({ ...entry.attachment })),
      commitMetadata: () => {
        if (metadataRemoved) return;
        const current = this.loadIndex();
        const ids = new Set(journal.entries.map((entry) => `${entry.attachment.memoryId}\u0000${entry.attachment.id}`));
        this.saveIndex({
          version: 1,
          attachments: current.attachments.filter((attachment) => !ids.has(`${attachment.memoryId}\u0000${attachment.id}`)),
        });
        metadataRemoved = true;
        try { this.saveJournal(journal); } catch (error) {
          metadataRemoved = false;
          throw error;
        }
      },
      rollback: () => {
        this.restoreJournal(journal);
        metadataRemoved = false;
      },
      finalize: () => {
        this.finalizeJournal(journal);
      },
    };
  }

  private restoreJournal(journal: DeletionJournal): void {
    this.restoreJournalFiles(journal, journal.entries);
    const index = this.loadIndex();
    const existing = new Set(index.attachments.map((attachment) => `${attachment.memoryId}\u0000${attachment.id}`));
    const missing = journal.entries
      .filter((entry) => !existing.has(`${entry.attachment.memoryId}\u0000${entry.attachment.id}`))
      .map((entry) => ({
        ...entry.attachment,
        relativePath: entry.relativePath,
      }));
    if (missing.length > 0) this.saveIndex({ version: 1, attachments: [...index.attachments, ...missing] });
    this.removeJournal(journal);
  }

  private restoreJournalFiles(journal: DeletionJournal, entries: DeletionJournalEntry[]): void {
    for (const entry of [...entries].reverse()) {
      const sourcePath = this.absoluteStoragePathFromRelative(entry.relativePath);
      const trashPath = this.absoluteStoragePathFromRelative(entry.trashRelativePath);
      if (!existsSync(trashPath)) {
        if (existsSync(sourcePath)) continue;
        throw new Error(`Attachment content missing: ${entry.attachment.id}`);
      }
      this.assertSafeExistingPath(trashPath);
      if (existsSync(sourcePath)) {
        this.assertSafeExistingPath(sourcePath);
        const existing = readFileSync(sourcePath);
        const trashed = readFileSync(trashPath);
        if (!existing.equals(trashed)) throw new Error(`Attachment restore collision: ${entry.attachment.id}`);
        unlinkSync(trashPath);
      } else {
        mkdirSync(dirname(sourcePath), { recursive: true });
        this.assertSafeExistingPath(dirname(sourcePath));
        renameSync(trashPath, sourcePath);
      }
    }
    try { this.removeEmptyStorageDirForRelativePaths(journal.entries); } catch { /* cleanup is recoverable via the journal */ }
  }

  private finalizeJournal(journal: DeletionJournal): void {
    let cleanupSucceeded = true;
    for (const entry of journal.entries) {
      const trashPath = this.absoluteStoragePathFromRelative(entry.trashRelativePath);
      if (existsSync(trashPath)) {
        try {
          this.assertSafeExistingPath(trashPath);
          unlinkSync(trashPath);
        } catch { cleanupSucceeded = false; }
      }
    }
    try {
      rmSync(join(this.rootDir, DELETION_TRASH_DIR, journal.transactionId), { recursive: true, force: true });
      rmSync(join(this.rootDir, DELETION_TRASH_DIR), { recursive: true, force: true });
    } catch { cleanupSucceeded = false; }
    if (cleanupSucceeded || !existsSync(join(this.rootDir, DELETION_TRASH_DIR, journal.transactionId))) {
      try { this.removeJournal(journal); } catch { /* leave the journal for the next reconciliation */ }
    }
  }

  private removeEmptyStorageDirForRelativePaths(entries: DeletionJournalEntry[]): void {
    for (const entry of entries) {
      const pathParts = entry.relativePath.split(/[\\/]/);
      if (pathParts.length > 1) this.removeEmptyStorageDir(decodeURIComponent(pathParts[0]));
    }
  }

  private loadJournal(): DeletionJournal | null {
    if (!existsSync(this.journalPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.journalPath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Memory attachment deletion journal is invalid: ${String(error)}`);
    }
    if (!isDeletionJournal(parsed)) throw new Error('Memory attachment deletion journal is invalid');
    return parsed;
  }

  private saveJournal(journal: DeletionJournal): void {
    mkdirSync(this.rootDir, { recursive: true });
    (this.options.atomicWrite ?? atomicWriteFileSync)(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  }

  private removeJournal(_journal: DeletionJournal): void {
    if (existsSync(this.journalPath)) unlinkSync(this.journalPath);
  }

  private absoluteStoragePathFromRelative(relativePath: string): string {
    const path = join(this.rootDir, relativePath);
    this.assertInside(this.rootDir, path);
    return path;
  }

  repairOrphans(liveMemoryIds: Set<string>): { removedMetadata: number; removedFiles: number } {
    if (existsSync(this.rootDir)) this.assertSafeExistingPath(this.rootDir);
    const index = this.loadIndex();
    const retained: StoredMemoryAttachment[] = [];
    let removedMetadata = 0;
    let removedFiles = 0;
    for (const attachment of index.attachments) {
      const sourcePath = this.absoluteStoragePath(attachment);
      if (!liveMemoryIds.has(attachment.memoryId) || !existsSync(sourcePath)) {
        removedMetadata += 1;
        if (existsSync(sourcePath)) {
          this.assertSafeExistingPath(sourcePath);
          unlinkSync(sourcePath);
          removedFiles += 1;
        }
      } else {
        retained.push(attachment);
      }
    }
    if (removedMetadata > 0) this.saveIndex({ version: 1, attachments: retained });

    if (existsSync(this.rootDir)) {
      for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === DELETION_TRASH_DIR) continue;
        let memoryId: string;
        try { memoryId = decodeURIComponent(entry.name); } catch { continue; }
        if (!liveMemoryIds.has(memoryId)) {
          const orphanDir = join(this.rootDir, entry.name);
          this.assertSafeExistingPath(orphanDir);
          rmSync(orphanDir, { recursive: true, force: true });
          removedFiles += 1;
        }
      }
    }
    return { removedMetadata, removedFiles };
  }

  private storageDir(memoryId: string): string {
    return join(this.rootDir, encodeURIComponent(memoryId));
  }

  private absoluteStoragePath(attachment: StoredMemoryAttachment): string {
    const path = join(this.rootDir, attachment.relativePath);
    this.assertInside(this.rootDir, path);
    return path;
  }

  private removeEmptyStorageDir(memoryId: string): void {
    const dir = this.storageDir(memoryId);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }

  private loadIndex(): AttachmentIndex {
    if (!existsSync(this.indexPath)) return { version: 1, attachments: [] };
    const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<AttachmentIndex>;
    if (raw.version !== 1 || !Array.isArray(raw.attachments)) throw new Error('Memory attachment index is invalid');
    const attachments = raw.attachments.filter(isStoredAttachment);
    for (const attachment of attachments) this.absoluteStoragePath(attachment);
    return { version: 1, attachments };
  }

  private saveIndex(index: AttachmentIndex): void {
    mkdirSync(this.rootDir, { recursive: true });
    const content = `${JSON.stringify(index, null, 2)}\n`;
    (this.options.atomicWrite ?? atomicWriteFileSync)(this.indexPath, content);
  }

  private assertInside(root: string, target: string): void {
    const resolvedRoot = resolve(root);
    const resolvedTarget = resolve(target);
    if (resolvedTarget !== resolvedRoot
      && !resolvedTarget.startsWith(`${resolvedRoot}\\`)
      && !resolvedTarget.startsWith(`${resolvedRoot}/`)) {
      throw new Error('Resolved attachment path escapes storage directory');
    }
  }

  private assertSafeExistingPath(target: string): void {
    if (!existsSync(target)) return;
    const realRoot = realpathSync(this.rootDir);
    const realTarget = realpathSync(target);
    this.assertInside(realRoot, realTarget);
    if (lstatSync(target).isSymbolicLink()) throw new Error('Symbolic links are not allowed in attachment storage');
  }

  private assertSafeTempDirectory(): void {
    const resolved = resolve(this.tempDir);
    const real = realpathSync(this.tempDir);
    if (!samePath(resolved, real) || lstatSync(this.tempDir).isSymbolicLink()) {
      throw new Error('Symbolic links and reparse points are not allowed for attachment temp storage');
    }
  }

  private assertSafeTempDestination(target: string): void {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed for attachment temp files');
      throw new Error('Attachment temp destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const tempRoot = realpathSync(this.tempDir);
    this.assertInside(tempRoot, resolve(target));
  }
}

function isStoredAttachment(value: unknown): value is StoredMemoryAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredMemoryAttachment>;
  return typeof item.id === 'string' && typeof item.memoryId === 'string'
    && typeof item.filename === 'string' && typeof item.sizeBytes === 'number'
    && typeof item.sha256 === 'string' && typeof item.createdAt === 'number'
    && typeof item.relativePath === 'string';
}

function isDeletionJournal(value: unknown): value is DeletionJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Partial<DeletionJournal>;
  if (journal.version !== 1 || typeof journal.transactionId !== 'string'
    || !Array.isArray(journal.entries)) return false;
  return journal.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Partial<DeletionJournalEntry>;
    const attachment = candidate.attachment;
    return typeof candidate.relativePath === 'string' && candidate.relativePath.length > 0
      && typeof candidate.trashRelativePath === 'string' && candidate.trashRelativePath.length > 0
      && isPublicAttachment(attachment);
  });
}

function isPublicAttachment(value: unknown): value is MemoryAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<MemoryAttachment>;
  return typeof item.id === 'string' && typeof item.memoryId === 'string'
    && typeof item.filename === 'string' && typeof item.sizeBytes === 'number'
    && typeof item.sha256 === 'string' && typeof item.createdAt === 'number';
}

function toPublicAttachment(attachment: StoredMemoryAttachment): MemoryAttachment {
  const { relativePath: _relativePath, ...publicAttachment } = attachment;
  return { ...publicAttachment };
}

function compareAttachments(a: MemoryAttachment, b: MemoryAttachment): number {
  return a.createdAt - b.createdAt || a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id);
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename.trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return base.length > 0 ? base : 'attachment.bin';
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}
