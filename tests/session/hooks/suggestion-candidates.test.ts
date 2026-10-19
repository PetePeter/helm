/**
 * Auto-recall's reach: the suggester's candidate list, built from the real
 * MemoryManager and scored by the real SuggestionService (BM25, no model).
 *
 * - a session is hinted at its OWN bound memories, never another session's
 * - the threshold and the Auto-recall switch apply to them like any memory
 * - project memories are hinted exactly as before
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryManager } from '../../../src/session/memory-manager';
import { createSuggestionCandidateSource } from '../../../src/session/hooks/suggestion-candidates';
import {
  Bm25SuggestionScorer,
  BoostedSuggestionScorer,
  SuggestionService,
} from '../../../src/session/hooks/suggestion-scorer';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SKILLS = [
  { id: 'graphify', name: 'graphify', description: 'Turn any input into a clustered knowledge graph. Trigger: /graphify', allProjects: true },
  { id: 'bq-import', name: 'BigQuery Import', description: 'Load exported CSV files into a warehouse table.', allProjects: true },
  { id: 'release-notes', name: 'Release Notes', description: 'Draft a changelog from merged pull requests.', allProjects: true },
];

const BAUD_PROMPT = 'what baud rate does the RS485 link on the EG004 charger need?';

function setup() {
  let tick = 1_000;
  let recall = true;
  let usageNotes = 0;
  const projects: Record<string, string | null> = { s1: 'p-a', s2: 'p-a', loose: null };
  const memory = new MemoryManager({ resolveSessionProject: (sessionId) => projects[sessionId] ?? null, now: () => ++tick });
  const service = new SuggestionService({
    getCandidates: createSuggestionCandidateSource({
      listSkills: () => SKILLS,
      listProjectMemories: (projectId) => memory.listProjectRecords(projectId),
      listBoundMemories: (sessionId) => memory.listBoundForSession(sessionId),
    }),
    memoriesEnabled: () => recall,
    scorer: new BoostedSuggestionScorer(new Bm25SuggestionScorer(), {
      getMemoryEdges: () => [],
      getWorkspacePlanIds: () => new Set(),
      usageBoost: () => 0,
    }),
    onSuggested: () => { usageNotes += 1; },
  });
  const suggest = (sessionId: string, prompt: string) => service.suggest(sessionId, prompt, projects[sessionId] ?? null);
  const suggestTool = (sessionId: string, query: string) => service.suggestTool(sessionId, query, projects[sessionId] ?? null);
  const saveBound = (sessionId: string) => memory.createForSession(sessionId, {
    tldr: 'RS485 on the EG004 charger needs 9600 baud',
    content: 'The EG004 charger only answers on its RS485 link at 9600 baud, 8N1.',
    sessionBound: true,
  })!;
  return { memory, service, suggest, suggestTool, saveBound, setRecall: (on: boolean) => { recall = on; }, usageNotes: () => usageNotes };
}

describe('suggester candidates: session-bound memories', () => {
  it('hints a bound memory to the session that owns it, and to no other session', async () => {
    const { suggest, saveBound } = setup();
    const saved = saveBound('s1');

    expect(await suggest('s2', BAUD_PROMPT)).toBeNull();
    expect(await suggest('s1', BAUD_PROMPT)).toBe(`possibly related: memory/${saved.id} (RS485 on the EG004 charger needs 9600 baud)`);
  });

  it('says nothing about a bound memory the prompt does not match', async () => {
    const { suggest, saveBound } = setup();
    saveBound('s1');

    expect(await suggest('s1', 'rename the variable and run the linter again')).toBeNull();
  });

  it('hints no bound memory while auto-recall is off, and still hints skills', async () => {
    const { suggest, saveBound, setRecall } = setup();
    const saved = saveBound('s1');
    setRecall(false);

    expect(await suggest('s1', BAUD_PROMPT)).toBeNull();
    expect(await suggest('s1', 'graphify this folder into a knowledge graph')).toContain('skill/graphify');

    setRecall(true);
    expect(await suggest('s1', BAUD_PROMPT)).toContain(`memory/${saved.id}`);
  });

  it('hints a session without a project at its own bound memory', async () => {
    const { suggest, saveBound } = setup();
    const saved = saveBound('loose');

    expect(await suggest('loose', BAUD_PROMPT)).toContain(`memory/${saved.id}`);
    expect(await suggest('s1', BAUD_PROMPT)).toBeNull();
  });

  it('hints a project memory to every session of the project, as before', async () => {
    const { memory, suggest } = setup();
    const shared = memory.createForSession('s1', {
      tldr: 'Vite preview server listens on port 4173',
      content: 'Run the preview build and open port 4173; the dev server is a different port.',
    })!;
    const prompt = 'which port does the vite preview server listen on?';

    expect(await suggest('s2', prompt)).toContain(`memory/${shared.id}`);
    expect(await suggest('s1', prompt)).toContain(`memory/${shared.id}`);
    expect(await suggest('loose', prompt)).toBeNull();
  });

  it('hints a bound memory to the rest of the project once its binding is released', async () => {
    const { memory, suggest, saveBound } = setup();
    const saved = saveBound('s1');
    expect(await suggest('s2', BAUD_PROMPT)).toBeNull();

    memory.releaseBinding(saved.id);

    expect(await suggest('s2', BAUD_PROMPT)).toContain(`memory/${saved.id}`);
  });

  it('uses tool results for the owning session, respects autoRecall, and does not train usage feedback', async () => {
    const { suggestTool, saveBound, setRecall, usageNotes } = setup();
    const saved = saveBound('s1');
    const query = `tool Read\nresult ${BAUD_PROMPT}`;

    setRecall(false);
    expect(await suggestTool('s1', 'tool Read\nresult graphify this folder into a knowledge graph')).toContain('skill/graphify');
    expect(await suggestTool('s1', query)).toBeNull();
    setRecall(true);
    expect(await suggestTool('s2', query)).toBeNull();
    expect(await suggestTool('s1', query)).toContain(`memory/${saved.id}`);
    expect(usageNotes()).toBe(0);
  });

  it('measures the real candidate-build, BM25, and formatting path on a local MemoryManager', async () => {
    const { memory, service, suggestTool } = setup();
    memory.createForSession('s1', {
      tldr: 'RS485 on the EG004 charger needs 9600 baud',
      content: 'The EG004 charger uses 9600 baud on its RS485 link.',
    });
    for (let index = 0; index < 48; index += 1) {
      memory.createForSession('s1', {
        tldr: `Unrelated fixture memory ${index}`,
        content: `Documentation for unrelated fixture topic ${index}, with independent terms and examples.`,
      });
    }

    const samples: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const start = performance.now();
      await suggestTool('s1', `tool Read\nresult ${BAUD_PROMPT}`);
      samples.push(performance.now() - start);
      // Reuse one session and candidate set while keeping every sample eligible.
      service.resetSuggestions('s1');
    }
    samples.sort((a, b) => a - b);
    const percentile = (fraction: number) => samples[Math.ceil(fraction * samples.length) - 1]!;
    console.info(`[P-1042] tool suggestion latency: P50 ${percentile(0.5).toFixed(2)} ms, P95 ${percentile(0.95).toFixed(2)} ms`);
    expect(samples).toHaveLength(100);
    expect(Number.isFinite(percentile(0.95))).toBe(true);
  });
});
