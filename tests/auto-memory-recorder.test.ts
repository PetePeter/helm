/**
 * Auto-save end to end: an API session finishes a turn, the judge runs
 * silently against the recording model, and at most one session-bound memory
 * is written.
 *
 * Real ApiSessionHost, RecordingModelRunner, AutoMemoryRecorder and
 * MemoryManager; a local HTTP server stands in for llama-server and answers
 * both the session's own requests and the judge's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ApiSessionHost } from '../src/session/api/api-session-host.js';
import { AutoMemoryRecorder, JUDGE_SYSTEM_PROMPT, splitTurns, type JudgeOutcome } from '../src/session/auto-memory-judge.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { RecordingModelRunner, apiSilentBackend } from '../src/session/silent-model-runner.js';

type Body = { messages: Array<{ role: string; content: string }> };

const VITE_ATOM = 'NEW\nTLDR: vite dev server runs on 5173\nCONTENT: The renderer dev server listens on port 5173.';

describe('auto-save for API sessions', () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;
  let judgePrompts: string[];
  /** What the judge answers, given its prompt; a number is an HTTP error status. */
  let judge: (prompt: string) => string | number;
  /** HTTP status of the session's own requests. */
  let sessionStatus: number;
  /** Scripted assistant messages for the session's own requests; once empty it answers 'the answer'. */
  let sessionReplies: Array<string | { tool_calls: unknown[] }>;
  /** Called as each of the session's own requests arrives, with their count so far. */
  let onSessionRequest: (count: number) => void;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-memory-'));
    judgePrompts = [];
    judge = () => 'NOTHING';
    sessionStatus = 200;
    sessionReplies = [];
    onSessionRequest = () => {};
    let sessionRequests = 0;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Body;
        const isJudge = body.messages[0].content === JUDGE_SYSTEM_PROMPT;
        if (isJudge) judgePrompts.push(body.messages[1].content);
        else onSessionRequest(++sessionRequests);
        const answer = isJudge ? judge(body.messages[1].content)
          : sessionStatus === 200 ? sessionReplies.shift() ?? 'the answer' : sessionStatus;
        res.writeHead(typeof answer === 'number' ? answer : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(typeof answer === 'number'
          ? { error: 'boom' }
          : { choices: [{ message: typeof answer === 'string' ? { content: answer } : { content: null, ...answer }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(options: { autoSave?: boolean; picked?: string; autoMemory?: boolean; historyDir?: string; tools?: boolean } = {}) {
    const live = { value: true };
    const hooks: string[] = [];
    const chats: string[] = [];
    const passes: Array<Promise<JudgeOutcome>> = [];
    const historyDir = options.historyDir ?? dir;
    let tick = 0;
    const memory = new MemoryManager({ resolveSessionProject: () => 'p-a', now: () => ++tick });
    // The recorder needs the runner, which needs the host: bound lazily, as in main.
    const host: ApiSessionHost = new ApiSessionHost({
      dispatchTool: async () => ({ ok: true }),
      postChat: async (_sessionId, message) => { chats.push(message); },
      mcpTools: () => [],
      listSkills: () => [],
      getMission: () => undefined,
      recordToolRequest: () => {},
      emitHook: (event) => hooks.push(event.event),
      historyDir,
      createMemory: () => ({ id: 'm' }),
      linkMemory: () => {},
      now: () => new Date('2026-10-14T10:00:00.000Z'),
      recordTurn: (sessionId, history) => { passes.push(recorder.recordTurn(sessionId, history)); },
    });
    const api = { baseUrl, model: 'qwen', allowedTools: options.tools ? ['Glob'] : [], slots: 1, handshake: false, ...(options.autoMemory === false ? { autoMemory: false } : {}) };
    const recorder = new AutoMemoryRecorder({
      runner: new RecordingModelRunner({
        getRecordingModel: () => options.picked ?? 'api-local',
        resolveModel: (ref) => (ref === 'api-local' ? { id: ref, kind: 'api', api } : null),
        backends: { api: apiSilentBackend(host) },
      }),
      isEnabled: () => options.autoSave ?? true,
      isLive: () => live.value,
      getMission: () => 'Get the renderer dev loop working',
      listBound: (sessionId) => memory.listBoundForSession(sessionId),
      create: (sessionId, atom) => { memory.createForSession(sessionId, { ...atom, sessionBound: true }); },
      update: (sessionId, id, atom) => { memory.updateForSession(sessionId, id, atom); },
    });
    const proc = host.create({ sessionId: 's1', cliType: 'api-local', sessionName: 'worker', cliSessionName: 'abc-1', api });
    const historyFile = path.join(historyDir, 'abc-1.json');
    /** Run one turn to its end, judge pass included. */
    const turn = async (text: string): Promise<JudgeOutcome | undefined> => {
      const stops = hooks.filter((hook) => hook.startsWith('Stop')).length;
      const judged = passes.length;
      proc.write(`${text}\r`);
      await vi.waitFor(() => expect(hooks.filter((hook) => hook.startsWith('Stop')).length).toBe(stops + 1));
      return passes.length > judged ? passes.at(-1) : undefined;
    };
    return { memory, proc, turn, hooks, chats, historyFile, live };
  }

  it('saves a key memory bound to the session, with the turn it came from', async () => {
    judge = () => VITE_ATOM;
    const { memory, turn, historyFile } = setup();

    expect(await turn('which port does vite use?')).toBe('created');

    const [saved] = memory.listBoundForSession('s1');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    expect(saved).toMatchObject({
      tldr: 'vite dev server runs on 5173',
      content: 'The renderer dev server listens on port 5173.',
      sessionId: 's1',
      sessionBound: true,
      sourceTurn: splitTurns(history)[0].key,
    });
    // Another session of the same project does not see it until a dream digests it.
    expect(memory.listRecordsForSession('s2')).toEqual([]);
    expect(judgePrompts[0]).toContain('MISSION (framing only, never save it):\nGet the renderer dev loop working');
    expect(judgePrompts[0]).toContain('USER: which port does vite use?\nASSISTANT: the answer');
  });

  it('writes one memory, not two, when overlapping passes see the same fact', async () => {
    judge = (prompt) => (prompt.includes('[1] vite dev server runs on 5173') ? 'NOTHING' : VITE_ATOM);
    const { memory, turn } = setup();

    expect(await turn('which port does vite use?')).toBe('created');
    expect(await turn('thanks, and the preview server?')).toBe('nothing');

    expect(memory.listBoundForSession('s1')).toHaveLength(1);
    expect(judgePrompts[1]).toContain('ALREADY SAVED (from the turns above, newest first):\n[1] vite dev server runs on 5173');
  });

  it('updates the saved memory when a later turn completes the picture', async () => {
    judge = (prompt) => (prompt.includes('[1] vite dev server runs on 5173')
      ? 'UPDATE 1\nTLDR: vite dev server runs on 5173, preview on 4173\nCONTENT: Dev 5173, preview 4173.'
      : VITE_ATOM);
    const { memory, turn, historyFile } = setup();

    await turn('which port does vite use?');
    const [before] = memory.listBoundForSession('s1');
    expect(await turn('and the preview server?')).toBe('updated');

    const after = memory.listBoundForSession('s1');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      tldr: 'vite dev server runs on 5173, preview on 4173',
      sessionBound: true,
      sourceTurn: splitTurns(history)[1].key,
    });
  });

  it('writes nothing when the session closed while the judge was still answering', async () => {
    const { memory, turn, live } = setup();
    judge = () => { live.value = false; return VITE_ATOM; };

    expect(await turn('which port does vite use?')).toBe('off');
    expect(judgePrompts).toHaveLength(1);
    expect(memory.listBoundForSession('s1')).toEqual([]);
  });

  it('judges a turn the user added to mid-way as one turn, tool results included', async () => {
    const { memory, turn, proc, historyFile } = setup({ tools: true });
    judge = () => VITE_ATOM;
    sessionReplies = [
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"vite.config.*"}' } }] },
      'the answer',
    ];
    onSessionRequest = (count) => { if (count === 1) proc.write('also check the preview port\r'); };

    expect(await turn('which port does vite use?')).toBe('created');

    const turns = splitTurns(JSON.parse(fs.readFileSync(historyFile, 'utf8')));
    expect(turns).toHaveLength(1);
    expect(memory.listBoundForSession('s1')[0].sourceTurn).toBe(turns[0].key);
    expect(judgePrompts[0]).toMatch(/TARGET \(the newest turn\):\nUSER: which port does vite use\?\nTOOL CALL: Glob [^\n]*\nTOOL RESULT: [\s\S]*\nUSER: also check the preview port\nASSISTANT: the answer/);
    expect(judgePrompts[0]).not.toContain('CONTEXT');
  });

  it('saves nothing from a reply it cannot read', async () => {
    judge = () => 'Sure! I think the port is worth remembering.';
    const { memory, turn } = setup();

    expect(await turn('which port does vite use?')).toBe('nothing');
    expect(memory.listBoundForSession('s1')).toEqual([]);
  });

  it.each([
    ['auto-save is off', { autoSave: false }, 'off'],
    ['no recording model is picked', { picked: '' }, 'off'],
    ['the API tool opted out', { autoMemory: false }, undefined],
  ] as const)('makes no judge request when %s', async (_name, options, outcome) => {
    judge = () => VITE_ATOM;
    const { memory, turn } = setup(options);

    expect(await turn('which port does vite use?')).toBe(outcome);
    expect(judgePrompts).toEqual([]);
    expect(memory.listBoundForSession('s1')).toEqual([]);
  });

  it('does not judge a turn that failed', async () => {
    sessionStatus = 500;
    const { turn } = setup();

    expect(await turn('which port does vite use?')).toBeUndefined();
    expect(judgePrompts).toEqual([]);
  });

  it('leaves the session untouched when the judge request fails', async () => {
    judge = () => 500;
    const { memory, turn, chats, historyFile } = setup();

    expect(await turn('which port does vite use?')).toBe('failed');
    expect(await turn('and the preview server?')).toBe('failed');

    expect(memory.listBoundForSession('s1')).toEqual([]);
    expect(chats).toEqual(['the answer', 'the answer']);
    expect(splitTurns(JSON.parse(fs.readFileSync(historyFile, 'utf8'))).map((item) => item.answer)).toEqual(['the answer', 'the answer']);
  });

  it('leaves history, chat and hook events byte-identical with auto-save on or off', async () => {
    judge = () => VITE_ATOM;
    const run = async (autoSave: boolean) => {
      const { turn, hooks, chats, historyFile } = setup({ autoSave, historyDir: path.join(dir, String(autoSave)) });
      await turn('which port does vite use?');
      await turn('and the preview server?');
      return { history: fs.readFileSync(historyFile, 'utf8'), hooks, chats };
    };

    const on = await run(true);
    const off = await run(false);

    expect(judgePrompts).toHaveLength(2);
    expect(on).toEqual(off);
  });
});
