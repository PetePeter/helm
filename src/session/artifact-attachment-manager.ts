/**
 * ArtifactAttachmentManager — on-disk storage for binary files attached to
 * manually-created artifacts.
 *
 * Mirrors the PlanAttachmentManager pattern: files live under a config-dir
 * subdirectory, a JSON index tracks metadata, and path-traversal is guarded
 * by assertInside().
 *
 * Images are rendered inline via the existing helm-img:// protocol. Binary
 * files (non-image) are presented as metadata cards with a shell-open action.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactAttachment } from '../types/artifact-attachment.js';
import { ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES, resolveSliceWindow } from './artifact-download.js';
import type { SliceWindow } from './artifact-download.js';
import { getConfigDir } from '../utils/app-paths.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const INDEX_FILE = 'index.json';

interface AttachmentIndex {
  version: 1;
  attachments: ArtifactAttachment[];
}

export interface AddAttachmentInput {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export class ArtifactAttachmentManager {
  private readonly rootDir: string;
  private readonly indexPath: string;

  constructor(configDir?: string) {
    const resolvedConfigDir = configDir ?? getConfigDir(__dirname);
    this.rootDir = join(resolvedConfigDir, 'artifact-attachments');
    this.indexPath = join(this.rootDir, INDEX_FILE);
  }

  /**
   * Add a file attachment for an artifact. Returns the attachment metadata.
   * Throws if the file exceeds 10MB.
   */
  add(artifactId: string, input: AddAttachmentInput): ArtifactAttachment {
    const safeFilename = sanitizeFilename(input.filename);
    if (input.content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachment exceeds 10MB size limit');
    }

    const now = Date.now();
    const id = randomUUID();
    const storageDir = this.artifactStorageDir(artifactId);
    mkdirSync(storageDir, { recursive: true });

    const storedFilename = `${id}${extname(safeFilename)}`;
    const storagePath = join(storageDir, storedFilename);
    this.assertInside(this.rootDir, storagePath);
    writeFileSync(storagePath, input.content);

    const attachment: ArtifactAttachment = {
      id,
      artifactId,
      filename: safeFilename,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      sizeBytes: input.content.byteLength,
      relativePath: `${artifactId}/${storedFilename}`,
      createdAt: now,
    };

    const index = this.loadIndex();
    index.attachments.push(attachment);
    this.saveIndex(index);
    logger.info(`[ArtifactAttachmentManager] Added attachment ${attachment.id} to artifact ${artifactId}`);
    return attachment;
  }

  /** Get a single attachment's metadata. Returns null if not found. */
  get(artifactId: string, attachmentId: string): ArtifactAttachment | null {
    return this.loadIndex().attachments.find(
      a => a.artifactId === artifactId && a.id === attachmentId,
    ) ?? null;
  }

  /**
   * Get the absolute on-disk path for an attachment's stored file.
   * Throws if the attachment or file is missing.
   */
  getPath(artifactId: string, attachmentId: string): string {
    const attachment = this.get(artifactId, attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    const absPath = join(this.rootDir, attachment.relativePath);
    this.assertInside(this.rootDir, absPath);
    if (!existsSync(absPath)) throw new Error(`Attachment file missing: ${attachmentId}`);
    return absPath;
  }

  /** Metadata only: callers must make an explicit, bounded read for bytes. */
  list(artifactId: string): ArtifactAttachment[] {
    return this.loadIndex().attachments.filter(a => a.artifactId === artifactId);
  }

  /** Read attachment bytes without exposing a caller-controlled filesystem path. */
  readBytes(artifactId: string, attachmentId: string): Buffer {
    const attachment = this.get(artifactId, attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    if (attachment.sizeBytes > ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES) {
      throw new Error(`Attachment exceeds the mobile wire budget — fetch it on the desktop instead`);
    }
    const path = this.getPath(artifactId, attachmentId);
    const bytes = readFileSync(path);
    if (bytes.byteLength > ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES) {
      throw new Error(`Attachment exceeds the mobile wire budget — fetch it on the desktop instead`);
    }
    return bytes;
  }

  /**
   * Read ONE window of an attachment, so a file far larger than a wire frame
   * can still cross in order. Only the window is read off disk — a 10MB photo
   * never becomes a 10MB Buffer here just to hand back 64KiB of it.
   *
   * `total` comes from the file on disk rather than the index: the index records
   * what was written, and a caller looping to `eof` must agree with the bytes it
   * is actually being given.
   */
  readSlice(
    artifactId: string,
    attachmentId: string,
    offset?: number,
    length?: number,
  ): { bytes: Buffer; window: SliceWindow; total: number } {
    const path = this.getPath(artifactId, attachmentId);
    const total = statSync(path).size;
    const window = resolveSliceWindow(total, offset, length);
    if (window.length === 0) return { bytes: Buffer.alloc(0), window, total };

    const buffer = Buffer.alloc(window.length);
    const handle = openSync(path, 'r');
    try {
      const read = readSync(handle, buffer, 0, window.length, window.offset);
      // A short read means the file changed under us; report what is true now
      // rather than padding the tail with zeroes the caller would save as data.
      return read === window.length
        ? { bytes: buffer, window, total }
        : { bytes: buffer.subarray(0, read), window: { ...window, length: read, eof: true }, total };
    } finally {
      closeSync(handle);
    }
  }

  /** Delete one attachment, used to roll back a failed artifact update. */
  delete(artifactId: string, attachmentId: string): boolean {
    const index = this.loadIndex();
    const attachment = index.attachments.find(a => a.artifactId === artifactId && a.id === attachmentId);
    if (!attachment) return false;

    const storagePath = join(this.rootDir, attachment.relativePath);
    this.assertInside(this.rootDir, storagePath);
    index.attachments = index.attachments.filter(a => a.id !== attachmentId);
    this.saveIndex(index);
    if (existsSync(storagePath)) unlinkSync(storagePath);
    return true;
  }

  /** Delete all attachments for an artifact. Returns count deleted. */
  deleteForArtifact(artifactId: string): number {
    const index = this.loadIndex();
    const owned = index.attachments.filter(a => a.artifactId === artifactId);
    if (owned.length === 0) return 0;

    index.attachments = index.attachments.filter(a => a.artifactId !== artifactId);
    this.saveIndex(index);

    const dir = this.artifactStorageDir(artifactId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

    logger.info(`[ArtifactAttachmentManager] Deleted ${owned.length} attachment(s) for artifact ${artifactId}`);
    return owned.length;
  }

  /** Remove attachment directories for artifacts that no longer exist. */
  pruneOrphans(liveArtifactIds: Set<string>): void {
    const index = this.loadIndex();
    const pruned = index.attachments.filter(a => liveArtifactIds.has(a.artifactId));
    const removed = index.attachments.length - pruned.length;
    if (removed === 0) return;

    // Remove directories for orphaned artifacts
    const orphanIds = new Set<string>();
    for (const a of index.attachments) {
      if (!liveArtifactIds.has(a.artifactId)) orphanIds.add(a.artifactId);
    }
    for (const artifactId of orphanIds) {
      const dir = this.artifactStorageDir(artifactId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }

    index.attachments = pruned;
    this.saveIndex(index);
    logger.info(`[ArtifactAttachmentManager] Pruned ${removed} orphan attachment(s) across ${orphanIds.size} artifact(s)`);
  }

  private artifactStorageDir(artifactId: string): string {
    return join(this.rootDir, artifactId);
  }

  private loadIndex(): AttachmentIndex {
    try {
      if (!existsSync(this.indexPath)) {
        return { version: 1, attachments: [] };
      }
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<AttachmentIndex>;
      return {
        version: 1,
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      };
    } catch (error) {
      logger.warn(`[ArtifactAttachmentManager] Failed to load index: ${error}`);
      return { version: 1, attachments: [] };
    }
  }

  private saveIndex(index: AttachmentIndex): void {
    mkdirSync(this.rootDir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  private assertInside(root: string, target: string): void {
    const resolvedRoot = resolve(root);
    const resolvedTarget = resolve(target);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}\\`) && !resolvedTarget.startsWith(`${resolvedRoot}/`)) {
      throw new Error('Resolved attachment path escapes storage directory');
    }
  }
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename.trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return base.length > 0 ? base : 'attachment.bin';
}
