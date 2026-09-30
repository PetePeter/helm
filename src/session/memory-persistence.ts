import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MEMORIES_FILE } from './persistence-paths.js';
import { atomicWriteFileSync } from './persistence-utils.js';
import {
  isMemoryEdgeType,
  cloneMemoryState,
  type MemoryAttachment,
  type MemoryEdge,
  type MemoryRecord,
  type MemoryState,
  validateMemoryState,
} from '../types/memory.js';

export type MemoryDiagnosticKind = 'corrupt' | 'unsupported' | 'invalid';

export interface MemoryDiagnostic {
  kind: MemoryDiagnosticKind;
  message: string;
  filePath: string;
}

export interface MemoryLoadResult {
  state: MemoryState;
  diagnostic?: MemoryDiagnostic;
  /** Envelope version the state was read from; drives the v1 project back-fill. */
  version?: number;
}

export interface MemoryRepairResult {
  repaired: boolean;
  diagnostic?: MemoryDiagnostic;
}

export interface MemoryPersistenceOptions {
  atomicWrite?: (filePath: string, content: string) => void;
}

const EMPTY_STATE: MemoryState = { records: [], edges: [] };

/** v1 was session-scoped only; v2 adds project scope, recall breadth and epochs. */
const STORE_VERSION = 2;

/** Every field that is absent on a fresh record and must survive a round trip. */
const OPTIONAL_NUMBERS = ['lastAccessedAt', 'recallSessionCount', 'dormantSince', 'createdAtEpoch'] as const;
const OPTIONAL_STRINGS = ['projectId', 'planId', 'lastRecallSessionId'] as const;
/** First-party flags; only `true` is stored, absent means false. */
const OPTIONAL_FLAGS = ['agentRun', 'summary'] as const;

function optionalFields(record: MemoryRecord): Partial<MemoryRecord> {
  const out: Record<string, unknown> = {};
  for (const field of OPTIONAL_NUMBERS) if (record[field] !== undefined) out[field] = record[field];
  for (const field of OPTIONAL_STRINGS) if (record[field] !== undefined) out[field] = record[field];
  for (const field of OPTIONAL_FLAGS) if (record[field] === true) out[field] = true;
  return out as Partial<MemoryRecord>;
}

export class MemoryPersistence {
  private lastDiagnostic: MemoryDiagnostic | undefined;

  constructor(
    private readonly filePath: string = MEMORIES_FILE,
    private readonly options: MemoryPersistenceOptions = {},
  ) {}

  load(): MemoryLoadResult {
    if (!existsSync(this.filePath)) {
      this.lastDiagnostic = undefined;
      return { state: cloneMemoryState(EMPTY_STATE) };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      return this.fail('corrupt', `Unable to read memory store: ${String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      return this.fail('corrupt', `Memory store is not valid JSON: ${String(error)}`, raw);
    }

    if (!isRecord(parsed)) return this.fail('invalid', 'Memory store root must be an object', raw);
    if (parsed.version !== undefined && parsed.version !== 1 && parsed.version !== STORE_VERSION) {
      return this.fail('unsupported', `Unsupported memory store version: ${String(parsed.version)}`, raw);
    }

    const isLegacy = parsed.version === undefined;
    const rawEdges = isLegacy ? parsed.links : parsed.edges ?? parsed.links;
    if (!Array.isArray(parsed.records) || !Array.isArray(rawEdges)) {
      return this.fail('invalid', 'Memory store must contain records and edges/links arrays', raw);
    }

    const records: MemoryRecord[] = [];
    for (const value of parsed.records) {
      const normalized = normalizeRecord(value);
      if (!normalized) return this.fail('invalid', 'Memory store contains an invalid record', raw);
      records.push(normalized);
    }
    const edges: MemoryEdge[] = [];
    for (const value of rawEdges) {
      const normalized = normalizeEdge(value);
      if (!normalized) return this.fail('invalid', 'Memory store contains an invalid edge', raw);
      edges.push(normalized);
    }

    const projectEpochs = normalizeProjectEpochs(parsed.projectEpochs);
    if (projectEpochs === null) return this.fail('invalid', 'Memory store contains invalid project epochs', raw);

    const state: MemoryState = { records, edges, ...(projectEpochs ? { projectEpochs } : {}) };
    try {
      validateMemoryState(state);
    } catch (error) {
      return this.fail('invalid', String(error), raw);
    }
    this.lastDiagnostic = undefined;
    return { state: cloneMemoryState(state), version: isLegacy ? 1 : parsed.version as number };
  }

  save(state: MemoryState): void {
    validateMemoryState(state);
    const envelope = {
      version: STORE_VERSION,
      records: state.records.map((record) => ({
        id: record.id,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        tldr: record.tldr,
        content: record.content,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...optionalFields(record),
        attachments: record.attachments.map((attachment) => ({ ...attachment })),
      })),
      edges: state.edges.map((edge) => ({ ...edge })),
      ...(state.projectEpochs ? { projectEpochs: state.projectEpochs } : {}),
    };
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    (this.options.atomicWrite ?? atomicWriteFileSync)(this.filePath, content);
  }

  repair(): MemoryRepairResult {
    const loaded = this.load();
    if (!loaded.diagnostic) return { repaired: false };
    if (!existsSync(this.filePath)) {
      this.lastDiagnostic = undefined;
      return { repaired: false, diagnostic: loaded.diagnostic };
    }

    const backupPath = `${this.filePath}.invalid`;
    if (existsSync(backupPath)) return { repaired: false, diagnostic: loaded.diagnostic };
    const raw = readFileSync(this.filePath, 'utf8');
    writeFileSync(backupPath, raw, 'utf8');
    try {
      this.save(EMPTY_STATE);
    } catch (error) {
      // Keep the original bytes available at both locations if replacement fails.
      try { writeFileSync(this.filePath, raw, 'utf8'); } catch { /* preserve best effort */ }
      throw error;
    }
    this.lastDiagnostic = undefined;
    return { repaired: true, diagnostic: loaded.diagnostic };
  }

  private fail(kind: MemoryDiagnosticKind, message: string, _raw?: string): MemoryLoadResult {
    const diagnostic: MemoryDiagnostic = { kind, message, filePath: this.filePath };
    this.lastDiagnostic = diagnostic;
    return { state: cloneMemoryState(EMPTY_STATE), diagnostic };
  }
}

function normalizeRecord(value: unknown): MemoryRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '') return null;
  if (typeof value.tldr !== 'string' || typeof value.content !== 'string') return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.trim() === '')) return null;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return null;
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) return null;
  const attachments: MemoryAttachment[] = [];
  for (const attachment of (value.attachments ?? [])) {
    const normalized = normalizeAttachment(attachment, value.id);
    if (!normalized) return null;
    attachments.push(normalized);
  }
  const optional: Record<string, unknown> = {};
  for (const field of OPTIONAL_NUMBERS) {
    if (value[field] === undefined) continue;
    if (!isFiniteNumber(value[field])) return null;
    optional[field] = value[field];
  }
  for (const field of OPTIONAL_STRINGS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || value[field].trim() === '') return null;
    optional[field] = value[field];
  }
  for (const field of OPTIONAL_FLAGS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') return null;
    if (value[field]) optional[field] = true;
  }
  return {
    id: value.id,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    tldr: value.tldr,
    content: value.content,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...optional,
    attachments,
  };
}

/** `null` signals a malformed block; `undefined` simply means none were stored. */
function normalizeProjectEpochs(value: unknown): MemoryState['projectEpochs'] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const out: NonNullable<MemoryState['projectEpochs']> = {};
  for (const [projectId, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isFiniteNumber(entry.epoch)) return null;
    if (typeof entry.lastSessionId !== 'string' || entry.lastSessionId.trim() === '') return null;
    out[projectId] = { epoch: entry.epoch, lastSessionId: entry.lastSessionId };
  }
  return out;
}

function normalizeAttachment(value: unknown, memoryId: string): MemoryAttachment | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '') return null;
  if (value.memoryId !== memoryId || typeof value.filename !== 'string' || value.filename.trim() === '') return null;
  if (value.contentType !== undefined && typeof value.contentType !== 'string') return null;
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) return null;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) return null;
  if (!isFiniteNumber(value.createdAt)) return null;
  return {
    id: value.id,
    memoryId,
    filename: value.filename,
    ...(value.contentType !== undefined ? { contentType: value.contentType } : {}),
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    createdAt: value.createdAt,
  };
}

function normalizeEdge(value: unknown): MemoryEdge | null {
  if (!isRecord(value) || typeof value.fromId !== 'string' || value.fromId.trim() === '') return null;
  if (typeof value.toId !== 'string' || value.toId.trim() === '') return null;
  // An unknown type (a newer build's) degrades to a plain link rather than
  // failing the whole store.
  return { fromId: value.fromId, toId: value.toId, ...(isMemoryEdgeType(value.type) ? { type: value.type } : {}) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
