import type { DreamIdeaCandidate, MemoryRecord } from '../types/memory.js';

export const DREAM_IDEA_CANDIDATE_LIMIT = 2;

/** Pick the next project-local ideas for a dream to research and expand. */
export function selectDreamIdeaCandidates(records: readonly MemoryRecord[]): DreamIdeaCandidate[] {
  return records
    .filter(isDreamIdea)
    .sort((left, right) => (left.lastExpandedAt ?? Number.NEGATIVE_INFINITY)
      - (right.lastExpandedAt ?? Number.NEGATIVE_INFINITY)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id))
    .slice(0, DREAM_IDEA_CANDIDATE_LIMIT)
    .map(({ id, tldr, ideaStage, lastExpandedAt }) => ({
      id,
      tldr,
      ideaStage,
      ...(lastExpandedAt === undefined ? {} : { lastExpandedAt }),
    }));
}

function isDreamIdea(record: MemoryRecord): record is MemoryRecord & {
  kind: 'idea';
  ideaStage: 'seed' | 'growing';
} {
  return record.kind === 'idea' && (record.ideaStage === 'seed' || record.ideaStage === 'growing');
}
