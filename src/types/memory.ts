export interface MemoryAttachment {
  id: string;
  memoryId: string;
  filename: string;
  contentType?: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export type MemoryAttachmentMetadata = MemoryAttachment;

export interface MemoryRecord {
  id: string;
  /** Owning Helm session. Legacy records may omit this until migrated. */
  sessionId?: string;
  tldr: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Trim signal, absent until the memory is first read. Deliberately not
   * `updatedAt`: reading a memory is not editing it, and folding the two would
   * make every read look like a fresh authoring. Absent means "never" — which
   * sorts last, not oldest.
   */
  lastAccessedAt?: number;
  /**
   * Owning project. Set ⇒ the memory outlives the session that wrote it, and
   * every later session in the same project can read it. Absent ⇒ the original
   * session-private behaviour, purged with its session.
   */
  projectId?: string;
  /**
   * The plan the writing session had claimed. Stamped at creation because it
   * cannot be reconstructed: a plan's `sessionId` is overwritten by whoever
   * claims it next, so the link only points the wrong way.
   */
  planId?: string;
  /**
   * How many DISTINCT sessions have read this. Not a hit count — an LLM reads a
   * memory into context once and never re-reads it, so frequency measures
   * context loss, not importance. Breadth is one vote per session.
   */
  recallSessionCount?: number;
  /** Dedupes the counter above; the last session to have read the record. */
  lastRecallSessionId?: string;
  /** Forgotten but not erased: hidden from recall, restored by being read. */
  dormantSince?: number;
  /** Project epoch at birth, so the grace period counts recall opportunities. */
  createdAtEpoch?: number;
  /**
   * Written by an API-tool subagent run, not authored as project knowledge.
   * Lets recall and the dreamer treat run results apart from curated memory.
   */
  agentRun?: boolean;
  /**
   * A summary node: its tldr/content describe, and its links point at the
   * detail and at child summaries — a struct with a description and pointers.
   */
  summary?: boolean;
  attachments: MemoryAttachment[];
}

/** Renderer-safe list item; durable content is fetched only when selected. */
export interface MemorySummary {
  id: string;
  tldr: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  projectId?: string;
  recallSessionCount?: number;
  dormantSince?: number;
  agentRun?: boolean;
  summary?: boolean;
  attachmentCount: number;
}

/**
 * Every memory a session owns, plus the edges between them — the whole forest
 * rather than a neighbourhood around one root. Isolated memories appear here
 * with no edges; a rooted traversal could never reach them.
 */
export interface MemoryForest {
  records: MemorySummary[];
  edges: MemoryEdge[];
}

export type MemorySortField = 'created' | 'updated' | 'accessed';

export interface MemoryListOptions {
  sortBy?: MemorySortField;
  order?: 'asc' | 'desc';
  /** Re-admit dormant memories — for the dream pass and the canvas toggle. */
  includeDormant?: boolean;
}

export interface MemoryDreamPlan {
  id: string;
  title: string;
  state: string;
  completed: boolean;
}

export const MEMORY_DREAM_MIN_CANDIDATES = 5;
export const MEMORY_DREAM_MAX_CANDIDATES = 50;

export interface DreamCandidate {
  id: string;
  tldr: string;
  recallSessionCount: number;
  connectedCount: number;
  ageDays: number;
  epochsSinceCreation: number;
  /** Content length: a long memory is likely several ideas waiting to be split. */
  contentChars: number;
  dormantSince?: number;
  plan: MemoryDreamPlan | null;
}

export interface MemoryDreamOptions {
  percentile?: number;
  minCandidates?: number;
  maxCandidates?: number;
}

export interface MemoryDreamResult {
  faded: DreamCandidate[];
  salient: DreamCandidate[];
  totals: {
    memories: number;
    dormant: number;
    eligible: number;
    epoch: number;
  };
}

/**
 * What a link says about its two memories. Absent means plain "related" —
 * every edge written before types existed, and any link made without one.
 */
export const MEMORY_EDGE_TYPES = ['supports', 'contradicts', 'part-of', 'example-of', 'supersedes'] as const;
export type MemoryEdgeType = typeof MEMORY_EDGE_TYPES[number];

export function isMemoryEdgeType(value: unknown): value is MemoryEdgeType {
  return typeof value === 'string' && (MEMORY_EDGE_TYPES as readonly string[]).includes(value);
}

export interface MemoryEdge {
  fromId: string;
  toId: string;
  type?: MemoryEdgeType;
}

/**
 * A project's position in its own timeline, measured in sessions rather than
 * wall-clock time: an idle fortnight must not age out knowledge that nobody
 * had the opportunity to recall.
 */
export interface MemoryProjectEpoch {
  epoch: number;
  lastSessionId: string;
}

export interface MemoryState {
  records: MemoryRecord[];
  edges: MemoryEdge[];
  projectEpochs?: Record<string, MemoryProjectEpoch>;
}

export type MemoryTraversalStatus = 'record' | 'reference' | 'cycle' | 'missing' | 'depth-limit';

export interface MemoryTraversalEntry {
  id: string;
  depth: number;
  path: string[];
  breadcrumbs: string[];
  status: MemoryTraversalStatus;
  via?: MemoryEdge;
  record?: MemoryRecord;
}

export interface MemoryTraversal {
  rootId: string;
  graphDepth: number;
  entries: MemoryTraversalEntry[];
}

export interface MemorySearchOptions {
  regex?: boolean;
  graphDepth?: number;
  includeDormant?: boolean;
}

/** One search root, aligned with `results`: how well it matched and whose it is. */
export interface MemorySearchHit {
  id: string;
  score: number;
  projectId?: string;
  /** From a project other than the caller's — knowledge to weigh, not to assume. */
  foreign: boolean;
}

export interface MemorySearchResult {
  query: string;
  regex: boolean;
  results: MemoryTraversal[];
  hits: MemorySearchHit[];
}

export type MemoryExportFormat = 'markdown' | 'json';

export interface MemoryAttachmentInput {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MemoryAttachmentTempFile {
  attachment: MemoryAttachment;
  tempPath: string;
}

export function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    records: state.records.map((record) => ({
      ...record,
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
    })),
    edges: state.edges.map((edge) => ({ ...edge })),
    ...(state.projectEpochs
      ? { projectEpochs: Object.fromEntries(
          Object.entries(state.projectEpochs).map(([id, value]) => [id, { ...value }]),
        ) }
      : {}),
  };
}

/** The renderer-safe projection of a record. One definition, so the list, the
 * forest and the MCP surface can never disagree about what a summary contains. */
export function toMemorySummary(record: MemoryRecord): MemorySummary {
  return {
    id: record.id,
    tldr: record.tldr,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastAccessedAt !== undefined ? { lastAccessedAt: record.lastAccessedAt } : {}),
    ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
    ...(record.recallSessionCount !== undefined ? { recallSessionCount: record.recallSessionCount } : {}),
    ...(record.dormantSince !== undefined ? { dormantSince: record.dormantSince } : {}),
    ...(record.agentRun ? { agentRun: true } : {}),
    ...(record.summary ? { summary: true } : {}),
    attachmentCount: record.attachments.length,
  };
}

export function cloneMemoryRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
  };
}

export function validateMemoryState(state: MemoryState): void {
  if (!state || !Array.isArray(state.records) || !Array.isArray(state.edges)) {
    throw new Error('Memory state must contain records and edges arrays');
  }

  const recordIds = new Set<string>();
  for (const record of state.records) {
    if (!record || typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error('Memory record id must be a non-empty string');
    }
    if (recordIds.has(record.id)) throw new Error(`Duplicate memory record id: ${record.id}`);
    recordIds.add(record.id);
    if (record.sessionId !== undefined && (typeof record.sessionId !== 'string' || record.sessionId.trim() === '')) {
      throw new Error(`Memory ${record.id} has an invalid owning session`);
    }
    if (typeof record.tldr !== 'string' || typeof record.content !== 'string') {
      throw new Error(`Memory ${record.id} must contain string tldr and content`);
    }
    if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.updatedAt)) {
      throw new Error(`Memory ${record.id} has invalid timestamps`);
    }
    if (record.lastAccessedAt !== undefined && !isFiniteNumber(record.lastAccessedAt)) {
      throw new Error(`Memory ${record.id} has an invalid lastAccessedAt`);
    }
    for (const field of ['projectId', 'planId', 'lastRecallSessionId'] as const) {
      const value = record[field];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`Memory ${record.id} has an invalid ${field}`);
      }
    }
    for (const field of ['dormantSince', 'createdAtEpoch', 'recallSessionCount'] as const) {
      const value = record[field];
      if (value !== undefined && !isFiniteNumber(value)) {
        throw new Error(`Memory ${record.id} has an invalid ${field}`);
      }
    }
    if (!Array.isArray(record.attachments)) throw new Error(`Memory ${record.id} has invalid attachments`);

    const attachmentIds = new Set<string>();
    for (const attachment of record.attachments) {
      validateMemoryAttachment(attachment, record.id);
      if (attachmentIds.has(attachment.id)) throw new Error(`Duplicate attachment id: ${attachment.id}`);
      attachmentIds.add(attachment.id);
    }
  }

  const edgeKeys = new Set<string>();
  for (const edge of state.edges) {
    if (!edge || typeof edge.fromId !== 'string' || edge.fromId.trim() === ''
      || typeof edge.toId !== 'string' || edge.toId.trim() === '') {
      throw new Error('Memory edge endpoints must be non-empty strings');
    }
    if (edge.type !== undefined && !isMemoryEdgeType(edge.type)) {
      throw new Error(`Unknown memory edge type: ${String(edge.type)}`);
    }
    const key = `${edge.fromId}\u0000${edge.toId}`;
    if (edgeKeys.has(key)) throw new Error(`Duplicate memory edge: ${edge.fromId} -> ${edge.toId}`);
    edgeKeys.add(key);
  }
}

function validateMemoryAttachment(attachment: MemoryAttachment, memoryId: string): void {
  if (!attachment || typeof attachment.id !== 'string' || attachment.id.trim() === '') {
    throw new Error(`Memory ${memoryId} has an invalid attachment id`);
  }
  if (attachment.memoryId !== memoryId) throw new Error(`Attachment ${attachment.id} belongs to another memory`);
  if (typeof attachment.filename !== 'string' || attachment.filename.trim() === '') {
    throw new Error(`Attachment ${attachment.id} has an invalid filename`);
  }
  if (attachment.contentType !== undefined && typeof attachment.contentType !== 'string') {
    throw new Error(`Attachment ${attachment.id} has an invalid MIME type`);
  }
  if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
    throw new Error(`Attachment ${attachment.id} has an invalid size`);
  }
  if (typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
    throw new Error(`Attachment ${attachment.id} has an invalid SHA-256 hash`);
  }
  if (!isFiniteNumber(attachment.createdAt)) throw new Error(`Attachment ${attachment.id} has an invalid timestamp`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
