import type {
  MemoryEdge,
  MemoryRecall,
  MemoryRecord,
  MemoryState,
  MemoryTraversal,
  MemoryTraversalEntry,
} from '../types/memory.js';
import { cloneMemoryState, validateMemoryState } from '../types/memory.js';

export const MAX_GRAPH_DEPTH = 100;

export class MemoryGraph {
  private readonly records: Map<string, MemoryRecord>;
  private readonly outgoing: Map<string, MemoryEdge[]>;

  constructor(state: MemoryState) {
    validateMemoryState(state);
    const snapshot = cloneMemoryState(state);
    this.records = new Map(snapshot.records.map((record) => [record.id, record]));
    this.outgoing = new Map<string, MemoryEdge[]>();
    for (const edge of snapshot.edges) {
      const edges = this.outgoing.get(edge.fromId) ?? [];
      edges.push(edge);
      this.outgoing.set(edge.fromId, edges);
    }
    for (const edges of this.outgoing.values()) {
      edges.sort((a, b) => a.toId.localeCompare(b.toId) || a.fromId.localeCompare(b.fromId));
    }
  }

  traverse(rootId: string, graphDepth = 0): MemoryTraversal {
    validateGraphDepth(graphDepth);
    const entries: MemoryTraversalEntry[] = [];
    const emittedRecords = new Set<string>();

    const visit = (id: string, depth: number, path: string[], via?: MemoryEdge): void => {
      const entryPath = [...path, id];
      if (depth > graphDepth) {
        entries.push(makeEntry(id, depth, entryPath, 'depth-limit', via));
        return;
      }

      const record = this.records.get(id);
      if (!record) {
        entries.push(makeEntry(id, depth, entryPath, 'missing', via));
        return;
      }

      const isCycle = path.includes(id);
      if (isCycle) {
        entries.push(makeEntry(id, depth, entryPath, 'cycle', via));
        return;
      }
      if (emittedRecords.has(id)) {
        entries.push(makeEntry(id, depth, entryPath, 'reference', via));
        return;
      }

      emittedRecords.add(id);
      entries.push(makeEntry(id, depth, entryPath, 'record', via, record));
      if (depth >= graphDepth) {
        if (graphDepth > 0) {
          for (const edge of this.outgoing.get(id) ?? []) {
            const cycle = entryPath.includes(edge.toId);
            entries.push(makeEntry(
              edge.toId,
              depth + 1,
              [...entryPath, edge.toId],
              cycle ? 'cycle' : 'depth-limit',
              edge,
            ));
          }
        }
        return;
      }
      for (const edge of this.outgoing.get(id) ?? []) {
        visit(edge.toId, depth + 1, entryPath, edge);
      }
    };

    visit(rootId, 0, []);
    return { rootId, graphDepth, entries };
  }
}

/**
 * The root in full, every memory it reaches as id + tldr. A hub's neighbours
 * can be essays; the reader fetches the ones it decides it needs.
 */
export function compactNeighbours(traversal: MemoryTraversal): MemoryRecall {
  return {
    ...traversal,
    entries: traversal.entries.map((entry) => (entry.depth === 0 || !entry.record
      ? entry
      : { ...entry, record: { id: entry.record.id, tldr: entry.record.tldr } })),
  };
}

export function deleteMemoryAndReroute(state: MemoryState, deletedId: string): MemoryState {
  validateMemoryState(state);
  if (!state.records.some((record) => record.id === deletedId)) return cloneMemoryState(state);

  const incoming = state.edges.filter((edge) => edge.toId === deletedId).map((edge) => edge.fromId);
  const outgoing = state.edges.filter((edge) => edge.fromId === deletedId).map((edge) => edge.toId);
  const rerouted: MemoryEdge[] = [];
  for (const fromId of incoming) {
    for (const toId of outgoing) rerouted.push({ fromId, toId });
  }

  const resultEdges: MemoryEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (edge: MemoryEdge): void => {
    if (edge.fromId === deletedId || edge.toId === deletedId) return;
    if (!state.records.some((record) => record.id === edge.fromId)
      || !state.records.some((record) => record.id === edge.toId)) return;
    const key = `${edge.fromId}\u0000${edge.toId}`;
    if (seen.has(key)) return;
    seen.add(key);
    resultEdges.push({ ...edge });
  };

  // The cross-product represents the deleted node's bridge and therefore keeps
  // its deterministic position ahead of unrelated original edges.
  for (const edge of rerouted) addEdge(edge);
  for (const edge of state.edges) {
    if (edge.fromId !== deletedId && edge.toId !== deletedId) addEdge(edge);
  }

  const result: MemoryState = {
    records: state.records.filter((record) => record.id !== deletedId).map((record) => ({
      ...record,
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
    })),
    edges: resultEdges,
  };
  validateMemoryState(result);
  return result;
}

export function validateGraphDepth(graphDepth: unknown): asserts graphDepth is number {
  if (typeof graphDepth !== 'number' || !Number.isSafeInteger(graphDepth)
    || graphDepth < 0 || graphDepth > MAX_GRAPH_DEPTH) {
    throw new Error(`graphDepth must be a nonnegative integer no greater than ${MAX_GRAPH_DEPTH}`);
  }
}

function makeEntry(
  id: string,
  depth: number,
  path: string[],
  status: MemoryTraversalEntry['status'],
  via?: MemoryEdge,
  record?: MemoryRecord,
): MemoryTraversalEntry {
  return {
    id,
    depth,
    path,
    breadcrumbs: [...path],
    status,
    ...(via ? { via: { ...via } } : {}),
    ...(record ? { record: {
      ...record,
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
    } } : {}),
  };
}
