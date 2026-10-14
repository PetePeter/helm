/**
 * The judge's window and reply parser: what a pass over one finished turn is
 * shown, and what Helm accepts back from a small model.
 *
 * Pure functions over real API-session history shapes.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/session/api/api-agent-loop.js';
import {
  buildJudgeWindow,
  estimateTokens,
  parseJudgeReply,
  renderJudgePrompt,
  splitTurns,
  type SavedMemory,
} from '../src/session/auto-memory-judge.js';

/** A user message as the agent loop stores it: the input, then Helm's per-turn context. */
function user(text: string, minute: number): ChatMessage {
  return { role: 'user', content: `${text}\n\n<helm_context>\ntime: 2026-10-14T10:${String(minute).padStart(2, '0')}:00.000Z\nsession: worker (s1)\n</helm_context>` };
}

function plainTurn(n: number): ChatMessage[] {
  return [user(`question ${n}`, n), { role: 'assistant', content: `answer ${n}` }];
}

function toolTurn(n: number, result: string): ChatMessage[] {
  return [
    user(`question ${n}`, n),
    { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'Read', arguments: `{"file":"f${n}.ts"}` } }] },
    { role: 'tool', tool_call_id: `c${n}`, content: result },
    { role: 'assistant', content: `answer ${n}` },
  ];
}

const keyOf = (history: ChatMessage[], turn: number) => splitTurns(history)[turn].key;

describe('buildJudgeWindow', () => {
  it('shows a one-turn session as mission + target, with no context', () => {
    const window = buildJudgeWindow({ turns: splitTurns(toolTurn(1, 'file body')), mission: 'Port the charger to RS485', bound: [] })!;

    expect(window.mission).toBe('Port the charger to RS485');
    expect(window.context).toEqual([]);
    expect(window.target).toMatchObject({ request: 'question 1', answer: 'answer 1' });
    expect(window.saved).toEqual([]);
  });

  it('gives the three turns before the target as context: user message and final answer only', () => {
    const history = [1, 2, 3, 4].flatMap((n) => toolTurn(n, `tool output ${n}`)).concat(toolTurn(5, 'tool output 5'));
    const window = buildJudgeWindow({ turns: splitTurns(history), bound: [] })!;

    expect(window.context).toEqual([
      { request: 'question 2', answer: 'answer 2' },
      { request: 'question 3', answer: 'answer 3' },
      { request: 'question 4', answer: 'answer 4' },
    ]);
    const prompt = renderJudgePrompt(window);
    // Only the target's tool call and result are shown.
    expect(prompt).toContain('f5.ts');
    expect(prompt).toContain('tool output 5');
    expect(prompt).not.toContain('f4.ts');
    expect(prompt).not.toContain('tool output 4');
    // Helm's per-turn context is not part of what the user asked.
    expect(prompt).not.toContain('helm_context');
  });

  it('labels the parts in order: mission, context, target, already saved', () => {
    const history = [...plainTurn(1), ...plainTurn(2)];
    const prompt = renderJudgePrompt(buildJudgeWindow({ turns: splitTurns(history), mission: 'Ship it', bound: [] })!);

    const positions = ['MISSION', 'CONTEXT', 'TARGET', 'ALREADY SAVED'].map((label) => prompt.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('builds a valid window for a session with no mission', () => {
    const window = buildJudgeWindow({ turns: splitTurns(plainTurn(1)), bound: [] })!;

    expect(window.mission).toBeUndefined();
    expect(renderJudgePrompt(window)).not.toContain('MISSION');
  });

  it('returns nothing to judge for an empty history', () => {
    expect(buildJudgeWindow({ turns: splitTurns([]), bound: [] })).toBeNull();
  });

  it('over budget, trims tool results before it drops any context turn, and keeps the mission', () => {
    const history = [...plainTurn(1), ...plainTurn(2), ...plainTurn(3), ...toolTurn(4, 'R'.repeat(40_000))];
    const window = buildJudgeWindow({ turns: splitTurns(history), mission: 'Keep me', bound: [], budgetTokens: 600 })!;
    const prompt = renderJudgePrompt(window);

    expect(estimateTokens(prompt)).toBeLessThanOrEqual(600);
    expect(window.mission).toBe('Keep me');
    expect(window.context).toHaveLength(3);
    expect(prompt).not.toContain('R'.repeat(2000));
    expect(prompt).toContain('answer 4');
  });

  it('still over budget with tool results gone, drops the oldest context turn first', () => {
    const long = (n: number): ChatMessage[] => [user(`question ${n} ${'q'.repeat(700)}`, n), { role: 'assistant', content: `answer ${n} ${'a'.repeat(700)}` }];
    const history = [...long(1), ...long(2), ...long(3), ...plainTurn(4)];
    const window = buildJudgeWindow({ turns: splitTurns(history), mission: 'Keep me', bound: [], budgetTokens: 900 })!;

    expect(estimateTokens(renderJudgePrompt(window))).toBeLessThanOrEqual(900);
    expect(window.mission).toBe('Keep me');
    expect(window.context.length).toBeLessThan(3);
    expect(window.context.at(-1)!.request).toContain('question 3');
    expect(window.target.request).toBe('question 4');
  });

  it('lists as already saved only memories whose source turn is in the window, newest first', () => {
    const history = [1, 2, 3, 4, 5].flatMap(plainTurn);
    const bound: SavedMemory[] = [
      { id: 'old', tldr: 'from turn 1', sourceTurn: keyOf(history, 0), updatedAt: 500 },
      { id: 'early', tldr: 'from turn 2', sourceTurn: keyOf(history, 1), updatedAt: 100 },
      { id: 'late', tldr: 'from turn 4', sourceTurn: keyOf(history, 3), updatedAt: 300 },
      { id: 'manual', tldr: 'bound, but not saved by the judge', updatedAt: 900 },
    ];
    const window = buildJudgeWindow({ turns: splitTurns(history), bound })!;

    expect(window.saved.map((memory) => memory.id)).toEqual(['late', 'early']);
    expect(renderJudgePrompt(window)).toMatch(/\[1\] from turn 4\n\[2\] from turn 2/);
  });

  it('stops listing a memory once its context turn was dropped for budget', () => {
    const long = (n: number): ChatMessage[] => [user(`question ${n} ${'q'.repeat(900)}`, n), { role: 'assistant', content: `answer ${n}` }];
    const history = [...long(1), ...long(2), ...plainTurn(3)];
    const bound: SavedMemory[] = [{ id: 'gone', tldr: 'from turn 1', sourceTurn: keyOf(history, 0), updatedAt: 1 }];

    const window = buildJudgeWindow({ turns: splitTurns(history), bound, budgetTokens: 500 })!;

    expect(window.context.map((turn) => turn.request.slice(0, 10))).toEqual(['question 2']);
    expect(window.saved).toEqual([]);
  });

  it('keeps a message the user added mid-turn, and a rollback note, inside the turn they landed in', () => {
    const history: ChatMessage[] = [
      ...plainTurn(1),
      ...toolTurn(2, 'tool output 2').slice(0, 3),
      { role: 'user', content: 'also check the preview port' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"preview"}' } }] },
      { role: 'tool', tool_call_id: 'c9', content: 'preview: 4173' },
      { role: 'user', content: '[Rolled back to checkpoint "probe". Your note: grep was enough]' },
      { role: 'assistant', content: 'answer 2' },
    ];
    const window = buildJudgeWindow({ turns: splitTurns(history), bound: [] })!;

    expect(splitTurns(history)).toHaveLength(2);
    expect(window.context).toEqual([{ request: 'question 1', answer: 'answer 1' }]);
    expect(window.target).toMatchObject({ request: 'question 2', answer: 'answer 2' });
    expect(window.target.steps.map((step) => step.kind)).toEqual(['call', 'result', 'user', 'call', 'result', 'user']);
    expect(renderJudgePrompt(window)).toContain('TOOL RESULT: tool output 2\nUSER: also check the preview port\nTOOL CALL: Grep');
  });

  it('shows a long mid-turn message whole while the window fits, and clips it only as a last resort', () => {
    const added = `also: ${'x'.repeat(900)} the preview port is 4173 ${'y'.repeat(900)}`;
    const history: ChatMessage[] = [
      ...toolTurn(1, 'tool output 1').slice(0, 3),
      { role: 'user', content: added },
      { role: 'assistant', content: 'answer 1' },
    ];

    expect(renderJudgePrompt(buildJudgeWindow({ turns: splitTurns(history), bound: [] })!)).toContain(added);
    const tight = renderJudgePrompt(buildJudgeWindow({ turns: splitTurns(history), bound: [], budgetTokens: 450 })!);
    expect(tight).not.toContain(added);
    expect(estimateTokens(tight)).toBeLessThanOrEqual(450);
  });

  it('treats what a compaction left behind, before the first request, as turns of their own', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '[Handover — your summary of the conversation before compaction]\nwe fixed the port' },
      { role: 'assistant', content: 'Understood — continuing from the summary.' },
      ...plainTurn(1),
    ];

    expect(buildJudgeWindow({ turns: splitTurns(history), bound: [] })!.context).toEqual([
      { request: '[Handover — your summary of the conversation before compaction]\nwe fixed the port', answer: 'Understood — continuing from the summary.' },
    ]);
  });

  it('keeps the newest steps of a turn with more tool calls than the budget holds', () => {
    const calls = Array.from({ length: 400 }, (_, n) => [
      { role: 'assistant' as const, content: null, tool_calls: [{ id: `c${n}`, type: 'function' as const, function: { name: 'Read', arguments: `{"file":"file-${n}.ts"}` } }] },
      { role: 'tool' as const, tool_call_id: `c${n}`, content: 'body' },
    ]).flat();
    const history: ChatMessage[] = [user('read everything', 1), ...calls, { role: 'assistant', content: 'done' }];

    const window = buildJudgeWindow({ turns: [...splitTurns(plainTurn(0)), ...splitTurns(history)], mission: 'Keep me', bound: [], budgetTokens: 600 })!;
    const prompt = renderJudgePrompt(window);

    expect(estimateTokens(prompt)).toBeLessThanOrEqual(600);
    const [marker, ...shown] = window.target.steps;
    expect(marker).toEqual({ kind: 'omitted', count: 800 - shown.length });
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.at(-2)).toMatchObject({ kind: 'call', args: '{"file":"file-399.ts"}' });
    expect(prompt).toContain(`USER: read everything\n[${800 - shown.length} earlier steps of this turn are not shown]\nTOOL CALL: Read`);
    expect(window.target).toMatchObject({ request: 'read everything', answer: 'done' });
    // Context goes before the target's own steps do.
    expect(window.context).toEqual([]);
    expect(window.mission).toBe('Keep me');
  });

  it('does not judge a window its fixed parts overflow', () => {
    const bound: SavedMemory[] = Array.from({ length: 60 }, (_, n) => ({
      id: `m${n}`, tldr: `saved fact number ${n} `.repeat(4), sourceTurn: keyOf(plainTurn(1), 0), updatedAt: n,
    }));

    expect(buildJudgeWindow({ turns: splitTurns(plainTurn(1)), bound, budgetTokens: 600 })).toBeNull();
  });

  it('keys a turn by its own user message, so the key survives earlier turns being forgotten', () => {
    const history = [1, 2, 3].flatMap(plainTurn);

    expect(keyOf(history.slice(2), 1)).toBe(keyOf(history, 2));
    expect(new Set(splitTurns(history).map((turn) => turn.key)).size).toBe(3);
  });
});

describe('parseJudgeReply', () => {
  it('reads NOTHING as no write', () => {
    expect(parseJudgeReply('NOTHING', 2)).toEqual({ kind: 'nothing' });
    expect(parseJudgeReply('  nothing.\n', 0)).toEqual({ kind: 'nothing' });
  });

  it('reads a new atom', () => {
    expect(parseJudgeReply('NEW\nTLDR: RS485 on the EG004 needs 9600 baud\nCONTENT: The EG004 only answers at 9600 8N1.\nFound while probing the bus.', 0)).toEqual({
      kind: 'new',
      tldr: 'RS485 on the EG004 needs 9600 baud',
      content: 'The EG004 only answers at 9600 8N1.\nFound while probing the bus.',
    });
  });

  it('reads an update that names a listed memory', () => {
    expect(parseJudgeReply('UPDATE 2\nTLDR: vite dev server runs on 5173\nCONTENT: Port 5173, set in vite.config.ts.', 2)).toEqual({
      kind: 'update', index: 2, tldr: 'vite dev server runs on 5173', content: 'Port 5173, set in vite.config.ts.',
    });
  });

  it('rejects an update that names a memory not in the list', () => {
    const reply = 'UPDATE 3\nTLDR: something\nCONTENT: something else';

    expect(parseJudgeReply(reply, 2)).toEqual({ kind: 'nothing' });
    expect(parseJudgeReply(reply.replace('3', '0'), 2)).toEqual({ kind: 'nothing' });
  });

  it('tolerates what small models wrap an answer in: thinking, fences, brackets', () => {
    expect(parseJudgeReply('<think>is the port a fact? yes</think>\n```\nNEW\nTLDR: vite runs on 5173\nCONTENT: Set in vite.config.ts.\n```', 0)).toEqual({
      kind: 'new', tldr: 'vite runs on 5173', content: 'Set in vite.config.ts.',
    });
    expect(parseJudgeReply('UPDATE [1]\ntldr: a\ncontent: b', 1)).toMatchObject({ kind: 'update', index: 1 });
  });

  it('saves nothing from a chatty or malformed reply, and never throws', () => {
    for (const reply of [
      '',
      'Sure! Here is the memory:\nNEW\nTLDR: a\nCONTENT: b',
      'NEW',
      'NEW\nTLDR: only a tldr',
      'NEW\nCONTENT: only content',
      'NEW\nTLDR:\nCONTENT: empty tldr',
      'UPDATE\nTLDR: a\nCONTENT: b',
      'MAYBE\nTLDR: a\nCONTENT: b',
    ]) {
      expect(parseJudgeReply(reply, 1)).toEqual({ kind: 'nothing' });
    }
  });

  it('cuts an essay down to an atom rather than storing it whole', () => {
    const parsed = parseJudgeReply(`NEW\nTLDR: ${'t'.repeat(400)}\nCONTENT: ${'c'.repeat(5000)}`, 0);

    expect(parsed.kind).toBe('new');
    if (parsed.kind !== 'new') return;
    expect(parsed.tldr.length).toBeLessThanOrEqual(200);
    expect(parsed.content.length).toBeLessThanOrEqual(600);
  });
});
