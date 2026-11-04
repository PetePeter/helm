import { isIdeaStage, isMemoryKind, type MemoryRecord } from '../types/memory.js';

export const IDEA_CONTENT_MAX_BYTES = 8_192;
export const REJECTED_IDEA_SIMILARITY_THRESHOLD = 0.6;

type IdeaCreatePolicyInput = {
  kind?: unknown;
  ideaStage?: unknown;
  tldr: string;
  content: string;
  sessionBound?: boolean;
};

type IdeaUpdatePolicyInput = {
  kind?: unknown;
  ideaStage?: unknown;
  tldr?: string;
  content?: string;
};

/** Ideas are deliberately absent from every automatic fact-recall path. */
export function isGeneralMemoryCandidate(record: Pick<MemoryRecord, 'kind'>): boolean {
  return record.kind !== 'idea';
}

/** The ring prefix is supplied by the hook layer to keep its policy canonical. */
export function getRingMemoryRequests(records: readonly MemoryRecord[], prefix: string): string[] {
  return records
    .filter(isGeneralMemoryCandidate)
    .map((record) => record.tldr)
    .filter((tldr) => tldr.startsWith(prefix));
}

export function assertIdeaCreate(
  input: IdeaCreatePolicyInput,
  projectId: string | null,
  records: readonly MemoryRecord[],
): void {
  assertIdeaMetadata(input.kind, input.ideaStage);
  if (input.kind !== 'idea') return;
  if (input.ideaStage !== undefined && input.ideaStage !== 'seed') {
    throw new Error('New ideas must start at stage seed');
  }
  assertProjectScopedIdea(projectId, input.sessionBound);
  assertIdeaContentSize(input.content);
  assertNoRejectedIdeaDuplicate(input.tldr, projectId, records);
}

export function assertIdeaUpdate(
  current: MemoryRecord,
  updates: IdeaUpdatePolicyInput,
  records: readonly MemoryRecord[],
): void {
  const kind = updates.kind ?? current.kind;
  const stage = updates.ideaStage
    ?? (current.kind === undefined && kind === 'idea' ? 'seed' : current.ideaStage);
  assertIdeaMetadata(kind, stage);
  if (current.kind !== 'idea' && kind === 'idea'
    && updates.ideaStage !== undefined && updates.ideaStage !== 'seed') {
    throw new Error('New ideas must start at stage seed');
  }

  if (current.kind === 'idea' && current.ideaStage === 'rejected'
    && updates.ideaStage !== undefined && updates.ideaStage !== 'rejected') {
    throw new Error(`Rejected idea ${current.id} has a terminal stage`);
  }

  if (kind !== 'idea') return;
  assertProjectScopedIdea(current.projectId ?? null, current.sessionBound);
  assertIdeaContentSize(updates.content ?? current.content);
  if (current.kind !== 'idea') {
    assertNoRejectedIdeaDuplicate(updates.tldr ?? current.tldr, current.projectId ?? null, records, current.id);
  }
}

export function assertIdeaMetadata(kind: unknown, stage: unknown): void {
  if (kind !== undefined && !isMemoryKind(kind)) {
    throw new Error('kind must be one of: idea');
  }
  if (stage !== undefined && !isIdeaStage(stage)) {
    throw new Error('ideaStage must be one of: seed, growing, suggested, accepted, rejected');
  }
  if (stage !== undefined && kind !== 'idea') {
    throw new Error('ideaStage requires kind=idea');
  }
}

function assertProjectScopedIdea(projectId: string | null, sessionBound?: boolean): void {
  if (!projectId) throw new Error('An idea memory requires a project-scoped session');
  if (sessionBound) throw new Error('An idea memory cannot be session-bound');
}

function assertIdeaContentSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > IDEA_CONTENT_MAX_BYTES) {
    throw new Error(`Idea content must be at most ${IDEA_CONTENT_MAX_BYTES} UTF-8 bytes`);
  }
}

function assertNoRejectedIdeaDuplicate(
  tldr: string,
  projectId: string | null,
  records: readonly MemoryRecord[],
  excludeId?: string,
): void {
  const duplicate = findRejectedIdeaDuplicate(tldr, projectId, records, excludeId);
  if (duplicate) throw new Error(`Idea is too similar to rejected idea ${duplicate.id}`);
}

function findRejectedIdeaDuplicate(
  tldr: string,
  projectId: string | null,
  records: readonly MemoryRecord[],
  excludeId?: string,
): MemoryRecord | undefined {
  if (!projectId) return undefined;
  const tokens = ideaTokens(tldr);
  if (tokens.size === 0) return undefined;

  return records.find((record) => {
    if (record.id === excludeId || record.projectId !== projectId
      || record.kind !== 'idea' || record.ideaStage !== 'rejected') return false;
    const rejectedTokens = ideaTokens(record.tldr);
    if (rejectedTokens.size === 0) return false;
    const intersection = [...tokens].filter((token) => rejectedTokens.has(token)).length;
    const union = new Set([...tokens, ...rejectedTokens]).size;
    return union > 0 && intersection / union >= REJECTED_IDEA_SIMILARITY_THRESHOLD;
  });
}

function ideaTokens(tldr: string): Set<string> {
  return new Set(tldr
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2));
}
