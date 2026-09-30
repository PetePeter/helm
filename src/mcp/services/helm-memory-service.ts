import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { MemoryAttachmentManager } from '../../session/memory-attachment-manager.js';
import type { ArtifactTempRegistry } from '../../session/artifact-temp-registry.js';
import { MemoryExporter } from '../../session/memory-exporter.js';
import { MemoryManager, type CreateMemoryInput, type UpdateMemoryInput } from '../../session/memory-manager.js';
import { toMemorySummary } from '../../types/memory.js';
import type {
  MemoryAttachment,
  MemoryAttachmentTempFile,
  MemoryDreamOptions,
  MemoryDreamPlan,
  MemoryDreamResult,
  MemoryExportFormat,
  MemoryForest,
  MemoryEdgeType,
  MemoryListOptions,
  MemorySearchHit,
  MemorySearchResult,
  MemoryRecord,
  MemorySummary,
  MemoryTraversal,
} from '../../types/memory.js';

const MCP_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** A memory should hold one idea; past this it is probably several. Advisory only. */
export const ATOM_SOFT_LIMIT = 300;
const SIMILAR_LIMIT = 5;

/**
 * What writing a memory returns to an AI: the record, the closest memories it
 * should consider linking, and a nudge when it is too big to be one idea.
 */
export type WrittenMemory = MemoryRecord & { similar: MemorySearchHit[]; atomHint?: string };

export interface MemoryExportResult {
  format: MemoryExportFormat;
  content: string;
  graphDepth: number;
  rootId?: string;
}

/** Session-scoped MCP facade for durable memories and their binary attachments. */
export class HelmMemoryService {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly attachmentManager: MemoryAttachmentManager,
    private readonly tempRegistry?: ArtifactTempRegistry,
    private readonly resolvePlan?: (planId: string) => MemoryDreamPlan | null,
  ) {}

  listMemories(sessionId: string, options: MemoryListOptions = {}): MemoryRecord[] {
    return this.memoryManager.listRecordsForSession(sessionId, options);
  }

  listMemorySummaries(sessionId: string, options: MemoryListOptions = {}): MemorySummary[] {
    return this.memoryManager.listRecordsForSession(sessionId, options).map(toMemorySummary);
  }

  /** Every owned memory plus the edges between them — what the canvas draws. */
  graphAllMemories(sessionId: string): MemoryForest {
    return this.memoryManager.forestForSession(sessionId);
  }

  getMemoryRecord(sessionId: string, id: string): MemoryRecord | null {
    return this.memoryManager.getRecordForSession(sessionId, id);
  }

  getMemory(sessionId: string, id: string, graphDepth = 0): MemoryTraversal | null {
    return this.memoryManager.getForSession(sessionId, id, graphDepth);
  }

  createMemory(sessionId: string, input: CreateMemoryInput): MemoryRecord {
    return this.memoryManager.createForSession(sessionId, input);
  }

  /** The MCP write: the record plus the linking prompt that grows the graph. */
  createLinkableMemory(sessionId: string, input: CreateMemoryInput): WrittenMemory {
    const record = this.createMemory(sessionId, input);
    return {
      ...record,
      similar: this.memoryManager.similarForSession(sessionId, record.id, SIMILAR_LIMIT),
      ...(record.content.length > ATOM_SOFT_LIMIT
        ? { atomHint: `content is ${record.content.length} chars; one idea is usually under ${ATOM_SOFT_LIMIT}. Consider splitting it into linked memories.` }
        : {}),
    };
  }

  updateMemory(
    sessionId: string,
    id: string,
    updates: UpdateMemoryInput,
    expectedUpdatedAt?: number,
  ): MemoryRecord | null {
    return this.memoryManager.updateForSession(sessionId, id, updates, expectedUpdatedAt);
  }

  deleteMemory(sessionId: string, id: string): boolean {
    return this.memoryManager.deleteForSession(sessionId, id);
  }

  dreamMemories(sessionId: string, options: MemoryDreamOptions = {}): MemoryDreamResult {
    return this.memoryManager.dreamForSession(sessionId, options, this.resolvePlan ?? (() => null));
  }

  setMemoryDormant(sessionId: string, id: string, dormant: boolean): boolean {
    return this.memoryManager.setDormantForSession(sessionId, id, dormant);
  }

  searchMemories(sessionId: string, query: string, options: { regex?: boolean; graphDepth?: number } = {}): MemorySearchResult {
    return this.memoryManager.searchForSession(sessionId, query, options);
  }

  graphMemory(sessionId: string, rootId: string, graphDepth = 0): MemoryTraversal | null {
    return this.getMemory(sessionId, rootId, graphDepth);
  }

  exportMemories(
    sessionId: string,
    format: MemoryExportFormat,
    rootId?: string,
    graphDepth = 0,
  ): MemoryExportResult {
    const records = rootId
      ? [this.requireMemory(sessionId, rootId)]
      : this.memoryManager.listRecordsForSession(sessionId);
    const traversals = records
      .map((record) => this.memoryManager.getForSession(sessionId, record.id, graphDepth))
      .filter((traversal): traversal is MemoryTraversal => traversal !== null);

    const content = rootId
      ? this.formatTraversal(traversals[0]!, format)
      : this.formatTraversals(traversals, format);
    return {
      format,
      content,
      graphDepth,
      ...(rootId ? { rootId } : {}),
    };
  }

  linkMemory(sessionId: string, fromId: string, toId: string, type?: MemoryEdgeType): boolean {
    return this.memoryManager.linkForSession(sessionId, fromId, toId, type);
  }

  unlinkMemory(sessionId: string, fromId: string, toId: string): boolean {
    return this.memoryManager.unlinkForSession(sessionId, fromId, toId);
  }

  addMemoryAttachment(
    sessionId: string,
    memoryId: string,
    input: { filePath: string; filename: string; contentType?: string },
  ): MemoryAttachment {
    this.requireMemory(sessionId, memoryId);
    const content = readMemoryInputFile(input.filePath);
    return this.memoryManager.addAttachmentForSession(sessionId, memoryId, {
      filename: input.filename,
      content,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
  }

  listMemoryAttachments(sessionId: string, memoryId: string): MemoryAttachment[] {
    this.requireMemory(sessionId, memoryId);
    return this.attachmentManager.list(memoryId);
  }

  getMemoryAttachment(sessionId: string, memoryId: string, attachmentId: string): MemoryAttachmentTempFile {
    const memory = this.requireMemory(sessionId, memoryId);
    const attachment = memory.attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    const tempFile = this.attachmentManager.getToTempFile(attachment);
    this.tempRegistry?.record(sessionId, tempFile.tempPath);
    return tempFile;
  }

  deleteMemoryAttachment(sessionId: string, memoryId: string, attachmentId: string): boolean {
    this.requireMemory(sessionId, memoryId);
    return this.memoryManager.deleteAttachmentForSession(sessionId, memoryId, attachmentId);
  }

  private requireMemory(sessionId: string, id: string): MemoryRecord {
    const memory = this.memoryManager.getRecordForSession(sessionId, id);
    if (!memory) throw new Error(`Memory not found: ${id}`);
    return memory;
  }

  private formatTraversal(traversal: MemoryTraversal, format: MemoryExportFormat): string {
    return format === 'markdown' ? MemoryExporter.toMarkdown(traversal) : MemoryExporter.toJSON(traversal);
  }

  private formatTraversals(traversals: MemoryTraversal[], format: MemoryExportFormat): string {
    if (format === 'markdown') return traversals.map((traversal) => MemoryExporter.toMarkdown(traversal)).join('\n');
    const values = traversals.map((traversal) => JSON.parse(MemoryExporter.toJSON(traversal)) as unknown);
    return `${JSON.stringify(values, null, 2)}\n`;
  }
}

function readMemoryInputFile(filePath: string): Buffer {
  if (!isAbsolute(filePath)) throw new Error('filePath must be an absolute path');
  const fileStat = statSync(filePath);
  if (!fileStat.isFile()) throw new Error('filePath must point to a regular file');
  if (fileStat.size > MCP_FILE_MAX_BYTES) throw new Error('File exceeds 10MB size limit');
  return readFileSync(filePath);
}
