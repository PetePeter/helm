import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanAttachment, PlanAttachmentTempFile } from '../types/plan-attachment.js';
import type { PlanManager } from './plan-manager.js';
import { getTempDir } from '../utils/app-paths.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const INDEX_FILE = 'index.json';

interface AttachmentIndex {
  version: 1;
  attachments: PlanAttachment[];
}

export interface AddPlanAttachmentInput {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export class PlanAttachmentManager {
  private readonly rootDir: string;
  private readonly tempDir: string;
  private readonly indexPath: string;

  constructor(
    private readonly planManager: PlanManager,
    configDir: string,
    tempDir?: string,
  ) {
    this.rootDir = join(configDir, 'plan-attachments');
    this.tempDir = tempDir ?? getTempDir(__dirname);
    this.indexPath = join(this.rootDir, INDEX_FILE);
  }

  list(planId: string): PlanAttachment[] {
    this.requirePlan(planId);
    return this.loadIndex().attachments
      .filter((attachment) => attachment.planId === planId)
      .sort((a, b) => a.createdAt - b.createdAt || a.filename.localeCompare(b.filename));
  }

  add(planId: string, input: AddPlanAttachmentInput): PlanAttachment {
    this.requirePlan(planId);
    const safeFilename = sanitizeFilename(input.filename);
    if (input.content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachment exceeds 10MB size limit');
    }

    const now = Date.now();
    const id = randomUUID();
    const encodedPlanId = encodeURIComponent(planId);
    const storageDir = this.planStorageDir(planId);
    mkdirSync(storageDir, { recursive: true });

    const storedFilename = `${id}${extname(safeFilename)}`;
    const storagePath = join(storageDir, storedFilename);
    this.assertInside(storageDir, storagePath);
    writeFileSync(storagePath, input.content);

    const attachment: PlanAttachment = {
      id,
      planId,
      filename: safeFilename,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      sizeBytes: input.content.byteLength,
      relativePath: `${encodedPlanId}/${storedFilename}`,
      createdAt: now,
      updatedAt: now,
    };

    const index = this.loadIndex();
    index.attachments.push(attachment);
    this.saveIndex(index);
    logger.info(`[PlanAttachmentManager] Added attachment ${attachment.id} to plan ${planId}`);
    return attachment;
  }

  delete(planId: string, attachmentId: string): boolean {
    this.requirePlan(planId);
    const index = this.loadIndex();
    const attachment = index.attachments.find((item) => item.planId === planId && item.id === attachmentId);
    if (!attachment) return false;

    const next = index.attachments.filter((item) => !(item.planId === planId && item.id === attachmentId));
    this.saveIndex({ version: 1, attachments: next });

    const storagePath = this.absoluteStoragePath(attachment);
    if (existsSync(storagePath)) {
      unlinkSync(storagePath);
    }
    logger.info(`[PlanAttachmentManager] Deleted attachment ${attachmentId} from plan ${planId}`);
    return true;
  }

  getToTempFile(planId: string, attachmentId: string): PlanAttachmentTempFile {
    this.requirePlan(planId);
    const attachment = this.loadIndex().attachments.find((item) => item.planId === planId && item.id === attachmentId);
    if (!attachment) {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }

    const storagePath = this.absoluteStoragePath(attachment);
    if (!existsSync(storagePath)) {
      throw new Error(`Attachment content missing: ${attachmentId}`);
    }

    mkdirSync(this.tempDir, { recursive: true });
    const tempPath = join(this.tempDir, `helm-attachment-${attachment.id}-${sanitizeFilename(attachment.filename)}`);
    this.assertInside(this.tempDir, tempPath);
    copyFileSync(storagePath, tempPath);
    return { attachment, tempPath };
  }

  deletePlanAttachments(planId: string): number {
    const index = this.loadIndex();
    const owned = index.attachments.filter((item) => item.planId === planId);
    if (owned.length === 0) return 0;
    this.saveIndex({ version: 1, attachments: index.attachments.filter((item) => item.planId !== planId) });
    const dir = this.planStorageDir(planId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    return owned.length;
  }

  hasAnyForPlanIds(planIds: string[]): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    const index = this.loadIndex();
    const planSet = new Set(planIds);
    for (const attachment of index.attachments) {
      if (planSet.has(attachment.planId)) {
        result[attachment.planId] = true;
        planSet.delete(attachment.planId);
      }
      if (planSet.size === 0) break;
    }
    for (const id of planIds) {
      if (!(id in result)) result[id] = false;
    }
    return result;
  }

  private requirePlan(planId: string): void {
    if (!this.planManager.getItem(planId)) {
      throw new Error(`Plan not found: ${planId}`);
    }
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
      logger.warn(`[PlanAttachmentManager] Failed to load attachment index: ${error}`);
      return { version: 1, attachments: [] };
    }
  }

  private saveIndex(index: AttachmentIndex): void {
    mkdirSync(this.rootDir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  private planStorageDir(planId: string): string {
    return join(this.rootDir, encodeURIComponent(planId));
  }

  private absoluteStoragePath(attachment: PlanAttachment): string {
    const storagePath = join(this.rootDir, attachment.relativePath);
    this.assertInside(this.rootDir, storagePath);
    return storagePath;
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
