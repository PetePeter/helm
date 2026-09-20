import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MemoryGraph, deleteMemoryAndReroute, validateGraphDepth } from './memory-graph.js';
import { MemoryPersistence } from './memory-persistence.js';
import type { MemoryDiagnostic } from './memory-persistence.js';
import { MemoryAttachmentManager } from './memory-attachment-manager.js';
import {
  cloneMemoryRecord,
  cloneMemoryState,
  MEMORY_DREAM_MAX_CANDIDATES,
  MEMORY_DREAM_MIN_CANDIDATES,
  toMemorySummary,
  type MemoryAttachment,
  type MemoryAttachmentInput,
  type MemoryDreamOptions,
  type MemoryDreamPlan,
  type MemoryDreamResult,
  type DreamCandidate,
  type MemoryForest,
  type MemoryListOptions,
  type MemoryRecord,
  type MemorySearchOptions,
  type MemorySortField,
  type MemorySearchResult,
  type MemoryState,
  type MemoryTraversal,
  validateMemoryState,
} from '../types/memory.js';

/**
 * How many project epochs a memory is protected for after birth.
 *
 * A brand-new memory has zero recalls and zero links, which is arithmetically
 * indistinguishable from stale junk. The grace period is the entire defence
 * against a scheduled dream deleting everything the last session just learned.
 */
export const GRACE_EPOCHS = 3;

export interface MemoryManagerOptions {
  persistence?: MemoryPersistence;
  attachmentManager?: MemoryAttachmentManager;
  persist?: (state: MemoryState) => void;
  now?: () => number;
  idFactory?: () => string;
  /**
   * Ownership is DERIVED, never accepted from the caller: a session may only
   * ever write into the project it is running in.
   */
  resolveSessionProject?: (sessionId: string) => string | null;
  resolveSessionPlan?: (sessionId: string) => string | null;
  graceEpochs?: number;
}

export interface CreateMemoryInput {
  tldr: string;
  content: string;
}

export interface UpdateMemoryInput {
  tldr?: string;
  content?: string;
}

export class MemoryManager extends EventEmitter {
  private state: MemoryState;
  private readonly persistSink?: (state: MemoryState) => void;
  private readonly persistence?: MemoryPersistence;
  private readonly attachmentManager?: MemoryAttachmentManager;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly resolveSessionProject?: (sessionId: string) => string | null;
  private readonly resolveSessionPlan?: (sessionId: string) => string | null;
  private readonly graceEpochs: number;
  private persistenceDiagnostic?: MemoryDiagnostic;

  constructor(options: MemoryManagerOptions = {}) {
    super();
    this.resolveSessionProject = options.resolveSessionProject;
    this.resolveSessionPlan = options.resolveSessionPlan;
    this.graceEpochs = options.graceEpochs ?? GRACE_EPOCHS;
    this.persistence = options.persistence;
    this.attachmentManager = options.attachmentManager;
    this.persistSink = options.persist ?? (options.persistence ? (state) => options.persistence!.save(state) : undefined);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    const loaded = options.persistence?.load();
    this.persistenceDiagnostic = loaded?.diagnostic;
    this.state = cloneMemoryState(loaded?.state ?? { records: [], edges: [] });
    validateMemoryState(this.state);
    if (loaded && !loaded.diagnostic && (loaded.version ?? 1) < 2) this.backfillProjects();
    if (this.attachmentManager && !loaded?.diagnostic) {
      this.attachmentManager.reconcile(this.state);
      this.attachmentManager.repairOrphans(new Set(this.state.records.map((record) => record.id)));
    }
  }

  /**
   * v1 → v2 upgrade: adopt each memory into its writing session's project,
   * where that session still resolves. Without it, everything written before
   * the upgrade would still be purged with its session — precisely what
   * project scope exists to stop. Memories whose session is already gone stay
   * unscoped; inventing a project for them would be a guess.
   */
  private backfillProjects(): void {
    if (!this.resolveSessionProject) return;
    let changed = false;
    for (const record of this.state.records) {
      if (record.projectId !== undefined || record.sessionId === undefined) continue;
      const projectId = this.resolveSessionProject(record.sessionId);
      if (projectId) {
        record.projectId = projectId;
        changed = true;
      }
    }
    // Best effort: a store too unhealthy to write to must still be readable.
    if (changed) try { this.persistSink?.(cloneMemoryState(this.state)); } catch { /* ignored */ }
  }

  /**
   * What a session may see: its own memories, plus every memory belonging to
   * the project it is running in. A project-less session keeps the original
   * session-private behaviour exactly.
   */
  private isVisible(record: MemoryRecord, sessionId: string, projectId: string | null): boolean {
    if (record.sessionId === sessionId) return true;
    return projectId !== null && record.projectId === projectId;
  }

  private scopedRecords(sessionId: string, includeDormant = false): MemoryRecord[] {
    const projectId = this.resolveSessionProject?.(sessionId) ?? null;
    return this.state.records.filter((record) =>
      this.isVisible(record, sessionId, projectId)
      && (includeDormant || record.dormantSince === undefined));
  }

  /** Whether a session may operate on a record at all — dormancy is no bar. */
  private owns(sessionId: string, id: string): boolean {
    return this.scopedRecords(sessionId, true).some((record) => record.id === id);
  }

  /** The project's current epoch; 0 for a project that has never been touched. */
  projectEpoch(projectId: string): number {
    return this.state.projectEpochs?.[projectId]?.epoch ?? 0;
  }

  /** What the epoch becomes once this session touches the project. */
  private epochAfterTouch(projectId: string, sessionId: string): number {
    const current = this.state.projectEpochs?.[projectId];
    if (!current) return 0;
    return current.lastSessionId === sessionId ? current.epoch : current.epoch + 1;
  }

  /**
   * Whether enough recall opportunities have passed for a memory to be a
   * candidate for forgetting. Unscoped memories are never eligible — they are
   * already governed by their session's lifetime.
   */
  isDiscardEligible(id: string): boolean {
    const record = this.state.records.find((item) => item.id === id);
    if (!record?.projectId) return false;
    return this.projectEpoch(record.projectId) - (record.createdAtEpoch ?? 0) >= this.graceEpochs;
  }

  /**
   * Return a bounded, disjoint review set for one project's dream pass.
   * Selection is intentionally descriptive rather than prescriptive: the
   * caller decides whether a faded memory should be pruned or a salient one
   * should be merged.
   */
  dreamForSession(
    sessionId: string,
    options: MemoryDreamOptions = {},
    resolvePlan: (planId: string) => MemoryDreamPlan | null = () => null,
  ): MemoryDreamResult {
    assertSessionId(sessionId);
    const percentile = normalizePercentile(options.percentile);
    const minCandidates = normalizeDreamCount(options.minCandidates, MEMORY_DREAM_MIN_CANDIDATES);
    const maxCandidates = normalizeDreamCount(options.maxCandidates, MEMORY_DREAM_MAX_CANDIDATES);
    if (minCandidates > maxCandidates) {
      throw new Error('minCandidates must not exceed maxCandidates');
    }
    const projectId = this.resolveSessionProject?.(sessionId) ?? null;
    if (!projectId) throw new Error('memory_dream requires a project-scoped session');
    const projectRecords = this.state.records.filter((record) => record.projectId === projectId);
    const eligible = projectRecords.filter((record) =>
      record.dormantSince === undefined && this.isDiscardEligible(record.id));
    const epoch = this.projectEpoch(projectId);
    const totals = {
      memories: projectRecords.length,
      dormant: projectRecords.filter((record) => record.dormantSince !== undefined).length,
      eligible: eligible.length,
      epoch,
    };
    if (eligible.length === 0) return { faded: [], salient: [], totals };

    // The bound applies to each decile. When the project is too small for two
    // full slices, split its records at the midpoint so neither side overlaps.
    const sideCount = Math.min(
      eligible.length,
      maxCandidates,
      Math.max(
        minCandidates,
        Math.ceil(eligible.length * percentile / 100),
      ),
    );
    const connectedCounts = new Map<string, number>();
    const projectIds = new Set(projectRecords.map((record) => record.id));
    for (const edge of this.state.edges) {
      if (projectIds.has(edge.fromId) && projectIds.has(edge.toId)) {
        connectedCounts.set(edge.toId, (connectedCounts.get(edge.toId) ?? 0) + 1);
      }
    }
    const candidates = eligible.map((record) => this.toDreamCandidate(record, epoch, connectedCounts, resolvePlan));
    const fadedCount = Math.min(sideCount, Math.ceil(eligible.length / 2));
    const salientCount = Math.min(sideCount, eligible.length - fadedCount);
    const faded = [...candidates]
      .sort(compareFaded)
      .slice(0, fadedCount);
    const fadedIds = new Set(faded.map((candidate) => candidate.id));
    const salient = [...candidates]
      .sort(compareSalient)
      .filter((candidate) => !fadedIds.has(candidate.id))
      .slice(0, salientCount);
    return { faded, salient, totals };
  }

  private toDreamCandidate(
    record: MemoryRecord,
    epoch: number,
    connectedCounts: Map<string, number>,
    resolvePlan: (planId: string) => MemoryDreamPlan | null,
  ): DreamCandidate {
    return {
      id: record.id,
      tldr: record.tldr,
      recallSessionCount: record.recallSessionCount ?? 0,
      connectedCount: connectedCounts.get(record.id) ?? 0,
      ageDays: Math.max(0, (this.now() - record.createdAt) / MS_PER_DAY),
      epochsSinceCreation: Math.max(0, epoch - (record.createdAtEpoch ?? 0)),
      ...(record.dormantSince !== undefined ? { dormantSince: record.dormantSince } : {}),
      plan: record.planId ? resolvePlan(record.planId) : null,
    };
  }

  /**
   * Forget, or remember again. Deliberately not an update: it must not advance
   * `updatedAt`, or every dream pass would make the memories it hid look like
   * the freshest things in the store.
   */
  setDormant(id: string, dormant: boolean): boolean {
    const current = this.state.records.find((record) => record.id === id);
    if (!current) return false;
    if ((current.dormantSince !== undefined) === dormant) return true;
    const timestamp = this.now();
    this.mutate((candidate) => {
      const record = candidate.records.find((item) => item.id === id)!;
      if (dormant) record.dormantSince = timestamp;
      else delete record.dormantSince;
      return { type: 'dormant', id, dormant, ...(current.sessionId ? { sessionId: current.sessionId } : {}) };
    });
    return true;
  }

  setDormantForSession(sessionId: string, id: string, dormant: boolean): boolean {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, id)) return false;
    return this.setDormant(id, dormant);
  }

  create(input: CreateMemoryInput): MemoryRecord {
    return this.createRecord(undefined, input);
  }

  createForSession(sessionId: string, input: CreateMemoryInput): MemoryRecord {
    assertSessionId(sessionId);
    return this.createRecord(sessionId, input);
  }

  private createRecord(sessionId: string | undefined, input: CreateMemoryInput): MemoryRecord {
    const timestamp = this.now();
    // Provenance is resolved here and nowhere else. It cannot be reconstructed
    // later — a plan's sessionId is overwritten by whoever claims it next.
    const projectId = sessionId ? this.resolveSessionProject?.(sessionId) ?? null : null;
    const planId = sessionId ? this.resolveSessionPlan?.(sessionId) ?? null : null;
    const record: MemoryRecord = {
      id: this.idFactory(),
      ...(sessionId ? { sessionId } : {}),
      tldr: input.tldr,
      content: input.content,
      createdAt: timestamp,
      updatedAt: timestamp,
      // Read the epoch this write lands in, not the one before it, or a memory
      // would be born already a full epoch into its own grace period.
      ...(projectId ? { projectId, createdAtEpoch: this.epochAfterTouch(projectId, sessionId!) } : {}),
      ...(planId ? { planId } : {}),
      attachments: [],
    };
    this.mutate((candidate) => {
      candidate.records.push(record);
      if (projectId && sessionId) advanceEpoch(candidate, projectId, sessionId);
      return { type: 'create', id: record.id, ...(sessionId ? { sessionId } : {}) };
    });
    return cloneMemoryRecord(record);
  }

  update(id: string, updates: UpdateMemoryInput, expectedUpdatedAt?: number): MemoryRecord | null {
    const current = this.state.records.find((record) => record.id === id);
    if (!current) return null;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      throw new Error(`Memory ${id} was updated concurrently. Expected updatedAt=${expectedUpdatedAt}, current updatedAt=${current.updatedAt}. Re-read it before updating.`);
    }
    const next: MemoryRecord = {
      ...current,
      ...(updates.tldr !== undefined ? { tldr: updates.tldr } : {}),
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      updatedAt: this.now(),
      attachments: current.attachments.map((attachment) => ({ ...attachment })),
    };
    this.mutate((candidate) => {
      const index = candidate.records.findIndex((record) => record.id === id);
      candidate.records[index] = next;
      return { type: 'update', id, ...(current.sessionId ? { sessionId: current.sessionId } : {}) };
    });
    return cloneMemoryRecord(next);
  }

  updateForSession(sessionId: string, id: string, updates: UpdateMemoryInput, expectedUpdatedAt?: number): MemoryRecord | null {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, id)) return null;
    return this.update(id, updates, expectedUpdatedAt);
  }

  getRecordForSession(sessionId: string, id: string, options: MemoryListOptions = {}): MemoryRecord | null {
    assertSessionId(sessionId);
    const record = this.scopedRecords(sessionId, options.includeDormant).find((item) => item.id === id);
    if (!record) return null;
    this.stampAccess([record.id], sessionId);
    return cloneMemoryRecord(this.state.records.find((item) => item.id === id)!);
  }

  listRecordsForSession(sessionId: string, options: MemoryListOptions = {}): MemoryRecord[] {
    assertSessionId(sessionId);
    const records = this.scopedRecords(sessionId, options.includeDormant).map(cloneMemoryRecord);
    return options.sortBy ? sortRecords(records, options.sortBy, options.order ?? 'desc') : records;
  }

  getForSession(sessionId: string, rootId: string, graphDepth = 0): MemoryTraversal | null {
    assertSessionId(sessionId);
    const scopedRecords = this.scopedRecords(sessionId);
    if (!scopedRecords.some((record) => record.id === rootId)) return null;
    const allowedIds = new Set(scopedRecords.map((record) => record.id));
    return new MemoryGraph({
      records: scopedRecords,
      // An owned source may point at a missing or foreign target. The graph
      // intentionally keeps that edge so the renderer can show a missing
      // marker without ever receiving the foreign record.
      edges: this.state.edges.filter((edge) => allowedIds.has(edge.fromId)),
    }).traverse(rootId, graphDepth);
  }

  /**
   * The session's whole graph, for canvas rendering.
   *
   * Unlike `getForSession`, dangling edges are dropped rather than kept as
   * `missing` markers: the forest has no node to anchor the far end of such an
   * edge to, so drawing it would produce a line to nowhere.
   */
  forestForSession(sessionId: string, options: MemoryListOptions = {}): MemoryForest {
    assertSessionId(sessionId);
    const scoped = this.scopedRecords(sessionId, options.includeDormant);
    const ownedIds = new Set(scoped.map((record) => record.id));
    return {
      records: scoped.map(toMemorySummary),
      edges: this.state.edges
        .filter((edge) => ownedIds.has(edge.fromId) && ownedIds.has(edge.toId))
        .map((edge) => ({ ...edge })),
    };
  }

  searchForSession(sessionId: string, query: string, options: MemorySearchOptions = {}): MemorySearchResult {
    assertSessionId(sessionId);
    const scopedRecords = this.scopedRecords(sessionId, options.includeDormant);
    const allowedIds = new Set(scopedRecords.map((record) => record.id));
    const graphDepth = options.graphDepth ?? 0;
    validateGraphDepth(graphDepth);
    const regexMode = options.regex === true;
    const expression = buildSearchExpression(query, regexMode);
    const graph = new MemoryGraph({
      records: scopedRecords,
      edges: this.state.edges.filter((edge) => allowedIds.has(edge.fromId)),
    });
    const matches = scopedRecords
      .filter((record) => expression.test(record.tldr) || expression.test(record.content))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      query,
      regex: regexMode,
      results: matches.map((record) => graph.traverse(record.id, graphDepth)),
    };
  }

  delete(id: string): boolean {
    const current = this.state.records.find((record) => record.id === id);
    if (!current) return false;
    const transaction = this.attachmentManager?.stageDeleteForMemory(id);
    try {
      transaction?.commitMetadata();
      this.mutate((candidate) => {
        const rerouted = deleteMemoryAndReroute(candidate, id);
        candidate.records = rerouted.records;
        candidate.edges = rerouted.edges;
        return { type: 'delete', id, ...(current.sessionId ? { sessionId: current.sessionId } : {}) };
      });
      transaction?.finalize();
    } catch (error) {
      if (transaction) this.rollbackAttachmentTransaction(transaction, error);
      throw error;
    }
    return true;
  }

  deleteForSession(sessionId: string, id: string): boolean {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, id)) return false;
    const visibleIds = new Set(this.scopedRecords(sessionId, true).map((record) => record.id));
    const transaction = this.attachmentManager?.stageDeleteForMemory(id);
    try {
      transaction?.commitMetadata();
      this.mutate((candidate) => {
        const ownedIds = visibleIds;
        const incoming = candidate.edges
          .filter((edge) => edge.toId === id && ownedIds.has(edge.fromId))
          .map((edge) => edge.fromId);
        const outgoing = candidate.edges
          .filter((edge) => edge.fromId === id && ownedIds.has(edge.toId))
          .map((edge) => edge.toId);
        candidate.records = candidate.records.filter((record) => record.id !== id);
        candidate.edges = candidate.edges.filter((edge) => edge.fromId !== id && edge.toId !== id);
        const existingKeys = new Set(candidate.edges.map((edge) => `${edge.fromId}\u0000${edge.toId}`));
        for (const fromId of incoming) {
          for (const toId of outgoing) {
            const key = `${fromId}\u0000${toId}`;
            if (fromId !== toId && !existingKeys.has(key)) {
              candidate.edges.push({ fromId, toId });
              existingKeys.add(key);
            }
          }
        }
        return { type: 'delete', id, sessionId };
      });
      transaction?.finalize();
    } catch (error) {
      if (transaction) this.rollbackAttachmentTransaction(transaction, error);
      throw error;
    }
    return true;
  }

  linkForSession(sessionId: string, fromId: string, toId: string): boolean {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, fromId) || !this.owns(sessionId, toId)) return false;
    return this.link(fromId, toId, sessionId);
  }

  unlinkForSession(sessionId: string, fromId: string, toId: string): boolean {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, fromId) || !this.owns(sessionId, toId)) return false;
    return this.unlink(fromId, toId, sessionId);
  }

  addAttachmentForSession(sessionId: string, memoryId: string, input: MemoryAttachmentInput): MemoryAttachment {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, memoryId)) throw new Error(`Memory not found: ${memoryId}`);
    return this.addAttachment(memoryId, input);
  }

  deleteAttachmentForSession(sessionId: string, memoryId: string, attachmentId: string): boolean {
    assertSessionId(sessionId);
    if (!this.owns(sessionId, memoryId)) return false;
    return this.deleteAttachment(memoryId, attachmentId);
  }

  /**
   * Drop a dead session's memories — except the project-scoped ones, which are
   * knowledge about the project rather than about the terminal that learned it.
   */
  purgeSession(sessionId: string): number {
    assertSessionId(sessionId);
    const ownedIds = new Set(this.state.records
      .filter((record) => record.sessionId === sessionId && record.projectId === undefined)
      .map((record) => record.id));
    return this.purgeIds(ownedIds, { type: 'session-purge', sessionId, count: ownedIds.size });
  }

  /** Remove every memory belonging to a project, when the project itself goes. */
  purgeProject(projectId: string): number {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('projectId must be a non-empty string');
    }
    const ownedIds = new Set(this.state.records
      .filter((record) => record.projectId === projectId)
      .map((record) => record.id));
    return this.purgeIds(ownedIds, { type: 'project-purge', projectId, count: ownedIds.size }, projectId);
  }

  private purgeIds(ownedIds: Set<string>, event: unknown, dropEpochFor?: string): number {
    if (ownedIds.size === 0) return 0;
    const transaction = this.attachmentManager?.stageDeleteForMemories(ownedIds);
    try {
      transaction?.commitMetadata();
      this.mutate((candidate) => {
        candidate.records = candidate.records.filter((record) => !ownedIds.has(record.id));
        candidate.edges = candidate.edges.filter((edge) => !ownedIds.has(edge.fromId) && !ownedIds.has(edge.toId));
        if (dropEpochFor && candidate.projectEpochs) delete candidate.projectEpochs[dropEpochFor];
        return event;
      });
      transaction?.finalize();
    } catch (error) {
      if (transaction) this.rollbackAttachmentTransaction(transaction, error);
      throw error;
    }
    return ownedIds.size;
  }

  /** Remove session-bound memories whose owning session is no longer recoverable. */
  pruneOrphanedSessions(retainedSessionIds: Set<string>): number {
    const orphanedIds = new Set(this.state.records
      // Project memories are exempt: their owning session being gone is the
      // normal case, not an orphaning.
      .filter((record) => record.sessionId !== undefined && record.projectId === undefined
        && !retainedSessionIds.has(record.sessionId))
      .map((record) => record.id));
    if (orphanedIds.size === 0) return 0;

    const transaction = this.attachmentManager?.stageDeleteForMemories(orphanedIds);
    try {
      transaction?.commitMetadata();
      this.mutate((candidate) => {
        candidate.records = candidate.records.filter((record) => !orphanedIds.has(record.id));
        candidate.edges = candidate.edges.filter((edge) => !orphanedIds.has(edge.fromId) && !orphanedIds.has(edge.toId));
        return { type: 'orphan-session-purge', count: orphanedIds.size };
      });
      transaction?.finalize();
    } catch (error) {
      if (transaction) this.rollbackAttachmentTransaction(transaction, error);
      throw error;
    }
    return orphanedIds.size;
  }

  link(fromId: string, toId: string, sessionId?: string): boolean {
    if (!this.state.records.some((record) => record.id === fromId)
      || !this.state.records.some((record) => record.id === toId)) return false;
    if (this.state.edges.some((edge) => edge.fromId === fromId && edge.toId === toId)) return true;
    this.mutate((candidate) => {
      candidate.edges.push({ fromId, toId });
      return { type: 'link', fromId, toId, ...(sessionId ? { sessionId } : {}) };
    });
    return true;
  }

  unlink(fromId: string, toId: string, sessionId?: string): boolean {
    if (!this.state.edges.some((edge) => edge.fromId === fromId && edge.toId === toId)) return false;
    this.mutate((candidate) => {
      candidate.edges = candidate.edges.filter((edge) => !(edge.fromId === fromId && edge.toId === toId));
      return { type: 'unlink', fromId, toId, ...(sessionId ? { sessionId } : {}) };
    });
    return true;
  }

  addAttachment(memoryId: string, input: MemoryAttachmentInput): MemoryAttachment {
    if (!this.state.records.some((record) => record.id === memoryId)) throw new Error(`Memory not found: ${memoryId}`);
    if (!this.attachmentManager) throw new Error('Memory attachment storage is not configured');
    const attachment = this.attachmentManager.add(memoryId, input);
    try {
      this.mutate((candidate) => {
        const record = candidate.records.find((item) => item.id === memoryId)!;
        record.attachments.push({ ...attachment });
        return { type: 'attachment-add', id: attachment.id, sessionId: record.sessionId };
      });
    } catch (error) {
      try { this.attachmentManager!.delete(memoryId, attachment.id); } catch { /* best effort compensation */ }
      throw error;
    }
    return { ...attachment };
  }

  deleteAttachment(memoryId: string, attachmentId: string): boolean {
    const record = this.state.records.find((item) => item.id === memoryId);
    if (!record || !record.attachments.some((attachment) => attachment.id === attachmentId)) return false;
    if (!this.attachmentManager) throw new Error('Memory attachment storage is not configured');
    const transaction = this.attachmentManager.stageDelete(memoryId, attachmentId);
    if (!transaction) throw new Error(`Attachment not found: ${attachmentId}`);
    try {
      transaction.commitMetadata();
      this.mutate((candidate) => {
        const next = candidate.records.find((item) => item.id === memoryId)!;
        next.attachments = next.attachments.filter((attachment) => attachment.id !== attachmentId);
        return { type: 'attachment-delete', id: attachmentId, sessionId: record.sessionId };
      });
      transaction.finalize();
    } catch (error) {
      this.rollbackAttachmentTransaction(transaction, error);
      throw error;
    }
    return true;
  }

  get(rootId: string, graphDepth = 0): MemoryTraversal {
    validateGraphDepth(graphDepth);
    return new MemoryGraph(this.state).traverse(rootId, graphDepth);
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult {
    const regexMode = options.regex === true;
    const expression = buildSearchExpression(query, regexMode);
    const graphDepth = options.graphDepth ?? 0;
    validateGraphDepth(graphDepth);
    const roots = this.state.records
      .filter((record) => expression.test(record.tldr) || expression.test(record.content))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      query,
      regex: regexMode,
      results: roots.map((record) => new MemoryGraph(this.state).traverse(record.id, graphDepth)),
    };
  }

  getRecord(id: string): MemoryRecord | null {
    const record = this.state.records.find((item) => item.id === id);
    return record ? cloneMemoryRecord(record) : null;
  }

  /**
   * The graph edges, read-only (G5 adjacency). A copy — callers must not be
   * able to mutate the graph through it. Cheap at real store sizes.
   */
  listEdges(): Array<{ fromId: string; toId: string }> {
    return this.state.edges.map((edge) => ({ ...edge }));
  }

  listRecords(): MemoryRecord[] {
    return this.state.records.map(cloneMemoryRecord);
  }

  exportState(): MemoryState {
    return cloneMemoryState(this.state);
  }

  repairPersistence(): ReturnType<MemoryPersistence['repair']> | null {
    const result = this.persistence?.repair() ?? null;
    if (result?.repaired) this.persistenceDiagnostic = undefined;
    return result;
  }

  /**
   * Record that memories were read or matched.
   *
   * Deliberately not routed through `mutate`: this is bookkeeping, not a
   * content change. It emits no `memory:changed` (the renderer would refresh on
   * every read, and a read during a render would loop), and it never throws —
   * a read must still succeed when the store is too unhealthy to write to.
   */
  private stampAccess(ids: string[], readerSessionId?: string): void {
    if (ids.length === 0 || this.persistenceDiagnostic) return;
    const targets = new Set(ids);
    const timestamp = this.now();
    const candidate = cloneMemoryState(this.state);
    for (const record of candidate.records) {
      if (!targets.has(record.id)) continue;
      record.lastAccessedAt = timestamp;
      // Being read is retrieval succeeding — the opposite of being forgotten.
      delete record.dormantSince;
      if (readerSessionId === undefined) continue;
      if (record.projectId) advanceEpoch(candidate, record.projectId, readerSessionId);
      // The author already holds the fact in context; re-reading it is not
      // evidence anyone else found it worth retrieving.
      if (record.sessionId === readerSessionId) continue;
      if (record.lastRecallSessionId !== readerSessionId) {
        record.recallSessionCount = (record.recallSessionCount ?? 0) + 1;
        record.lastRecallSessionId = readerSessionId;
      }
    }
    try {
      this.persistSink?.(cloneMemoryState(candidate));
    } catch {
      return;
    }
    this.state = candidate;
  }

  private mutate<T>(build: (candidate: MemoryState) => T): T {
    if (this.persistenceDiagnostic) {
      throw new Error(
        `Memory store is ${this.persistenceDiagnostic.kind}: ${this.persistenceDiagnostic.message} ` +
        'Call repairPersistence() before mutating memories.',
      );
    }
    const candidate = cloneMemoryState(this.state);
    const event = build(candidate);
    validateMemoryState(candidate);
    this.persistSink?.(cloneMemoryState(candidate));
    this.state = candidate;
    this.emit('memory:changed', event);
    return event;
  }

  private rollbackAttachmentTransaction(
    transaction: import('./memory-attachment-manager.js').MemoryAttachmentDeleteTransaction,
    originalError: unknown,
  ): void {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      throw new Error(`${String(originalError)}; attachment rollback failed: ${String(rollbackError)}`);
    }
  }
}

/**
 * Move a project one step along its own timeline, but only when a *different*
 * session touches it. The epoch counts recall opportunities, not calls: a
 * single session hammering the store must not age out everything it wrote, and
 * an idle fortnight must not age out anything at all.
 *
 * The first session to touch a project establishes epoch 0 rather than
 * advancing to 1 — nothing has had a chance to be recalled yet.
 */
function advanceEpoch(state: MemoryState, projectId: string, sessionId: string): void {
  state.projectEpochs ??= {};
  const current = state.projectEpochs[projectId];
  if (!current) {
    state.projectEpochs[projectId] = { epoch: 0, lastSessionId: sessionId };
    return;
  }
  if (current.lastSessionId === sessionId) return;
  state.projectEpochs[projectId] = { epoch: current.epoch + 1, lastSessionId: sessionId };
}

const SORT_FIELDS: Record<MemorySortField, keyof MemoryRecord> = {
  created: 'createdAt',
  updated: 'updatedAt',
  accessed: 'lastAccessedAt',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizePercentile(value: number | undefined): number {
  const percentile = value ?? 10;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error('percentile must be a finite number greater than 0 and at most 100');
  }
  return percentile;
}

function normalizeDreamCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value)
    || value < MEMORY_DREAM_MIN_CANDIDATES || value > MEMORY_DREAM_MAX_CANDIDATES) {
    throw new Error(`candidate counts must be integers from ${MEMORY_DREAM_MIN_CANDIDATES} through ${MEMORY_DREAM_MAX_CANDIDATES}`);
  }
  return value;
}

function compareFaded(left: DreamCandidate, right: DreamCandidate): number {
  return left.recallSessionCount - right.recallSessionCount
    || left.connectedCount - right.connectedCount
    || left.id.localeCompare(right.id);
}

function compareSalient(left: DreamCandidate, right: DreamCandidate): number {
  return right.recallSessionCount - left.recallSessionCount
    || right.connectedCount - left.connectedCount
    || left.id.localeCompare(right.id);
}

/**
 * Sort by a timestamp, with never-set values pinned to the end in BOTH
 * directions. Treating absent as 0 would rank never-read memories as the oldest
 * things in the store — precisely what a trim would delete first.
 */
function sortRecords(records: MemoryRecord[], sortBy: MemorySortField, order: 'asc' | 'desc'): MemoryRecord[] {
  const field = SORT_FIELDS[sortBy];
  const direction = order === 'asc' ? 1 : -1;
  return records.sort((a, b) => {
    const left = a[field] as number | undefined;
    const right = b[field] as number | undefined;
    if (left === undefined && right === undefined) return a.id.localeCompare(b.id);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return (left - right) * direction || a.id.localeCompare(b.id);
  });
}

/**
 * Literal queries fold case: nobody types `prepareDeploy` when looking for
 * "deploy". Regex mode is left alone — the caller asked for a regex, and
 * forcing `i` would remove the only way to express a case-sensitive search.
 */
function buildSearchExpression(query: string, regexMode: boolean): RegExp {
  return regexMode ? compileRegex(query) : new RegExp(escapeRegExp(query), 'i');
}

function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch (error) {
    throw new Error(`Invalid regular expression: ${String(error)}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId must be a non-empty string');
}
