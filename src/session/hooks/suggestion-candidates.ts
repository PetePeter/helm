/**
 * The suggester's candidate list for one prompt: the skills the session's
 * project can see, that project's shared memories, and the asking session's
 * OWN bound memories (what auto-save wrote for it and no dream has digested).
 *
 * This is the whole of auto-recall's reach. A bound memory enters through this
 * list or not at all — there is no second recall path, and another session's
 * bound memory is never a candidate. Ranking is the scorer's job, unchanged.
 */

import type { MemoryRecord } from '../../types/memory.js';
import type { SuggestionCandidate } from './suggestion-scorer.js';

export interface SuggestionCandidateDeps {
  /** Skills visible to the project, globals included. */
  listSkills: (projectId: string | null) => Array<{ id: string; name: string; description: string; allProjects?: boolean }>;
  /** The project's live, unbound memories. */
  listProjectMemories: (projectId: string) => MemoryRecord[];
  /** The session's own live bound memories. */
  listBoundMemories: (sessionId: string) => MemoryRecord[];
}

function memoryCandidate(record: MemoryRecord): SuggestionCandidate {
  return {
    type: 'memory',
    id: record.id,
    name: record.tldr,
    description: record.content,
    createdAt: record.createdAt,
    ...(record.planId ? { planId: record.planId } : {}),
  };
}

export function createSuggestionCandidateSource(
  deps: SuggestionCandidateDeps,
): (projectId: string | null, sessionId: string) => SuggestionCandidate[] {
  return (projectId, sessionId) => {
    const skills = deps.listSkills(projectId).map((skill): SuggestionCandidate => ({
      type: 'skill',
      id: skill.id,
      name: skill.name,
      description: skill.description,
      allProjects: skill.allProjects,
    }));
    const shared = projectId ? deps.listProjectMemories(projectId) : [];
    // A project-less session still has its own bound memories.
    const bound = deps.listBoundMemories(sessionId);
    return [...skills, ...[...shared, ...bound].map(memoryCandidate)];
  };
}
