/**
 * Auto-save for real CLI sessions: the transcript a CLI's hooks report is
 * turned into the judge's turns, and a Stop runs the same judge pass an API
 * session gets.
 *
 * The fixtures hold four turns per CLI in the record shapes of real logs
 * (tests/fixtures/transcripts), noise included. End to end uses the real
 * CliAutoMemory, AutoMemoryRecorder, RecordingModelRunner and MemoryManager;
 * a local HTTP server stands in for llama-server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ApiSessionHost } from '../src/session/api/api-session-host.js';
import { AutoMemoryRecorder, JUDGE_SYSTEM_PROMPT } from '../src/session/auto-memory-judge.js';
import { CliAutoMemory, readTranscriptTurns } from '../src/session/cli-auto-memory.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { RecordingModelRunner, apiSilentBackend } from '../src/session/silent-model-runner.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'transcripts');
const QUESTIONS = ['which port does the vite dev server use?', 'and the preview server?', 'why did the build fail?', 'what did we decide about ports?'];
const ANSWERS = [
  'Port 5173; the session state is set.',
  'Preview runs on 4173.',
  'The build failed because dist-electron was locked; closing Helm fixes it.',
  'Dev on 5173, preview on 4173.',
];
/** The line each fixture's turn starts at, counted from 0. */
const TURN_STARTS = { claude: [1, 13, 18, 28], codex: [5, 18, 22, 28], copilot: [3, 15, 23, 28] };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-auto-memory-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fixtureLines = (cli: string): string[] => fs.readFileSync(path.join(FIXTURES, `${cli}.jsonl`), 'utf8').trimEnd().split('\n');
/** A transcript holding the first `count` records of a fixture, plus an optional torn tail. */
function transcript(cli: string, count?: number, torn = ''): string {
  const file = path.join(dir, `${cli}.jsonl`);
  fs.writeFileSync(file, `${fixtureLines(cli).slice(0, count).join('\n')}\n${torn}`);
  return file;
}

describe.each(['claude', 'codex', 'copilot'] as const)('%s transcript turns', (cli) => {
  it('yields one turn per user request, with its final answer', async () => {
    const turns = await readTranscriptTurns(transcript(cli));

    expect(turns.map((turn) => turn.request)).toEqual(QUESTIONS);
    expect(turns.map((turn) => turn.answer)).toEqual(ANSWERS);
  });

  it('puts tool calls and their results on the turn that made them', async () => {
    const [first, second, third, fourth] = await readTranscriptTurns(transcript(cli));

    expect(first.steps.map((step) => step.kind)).toEqual(['call', 'result', 'call', 'result']);
    expect(first.steps[0]).toMatchObject({ kind: 'call', args: expect.stringContaining('port') });
    expect(first.steps[1]).toMatchObject({ kind: 'result', text: expect.stringContaining('port: 5173') });
    expect(first.steps[2]).toMatchObject({ kind: 'call', name: expect.stringContaining('session_set_aiagent_state') });
    expect(first.steps[3]).toEqual({ kind: 'result', text: '{"ok":true}' });
    expect(second.steps).toEqual([]);
    expect(third.steps.map((step) => step.kind)).toEqual(['call', 'result']);
    expect(third.steps[1]).toMatchObject({ kind: 'result', text: expect.stringContaining('EBUSY') });
    expect(fourth.steps).toEqual([]);
  });

  it('keeps a turn\'s identity as the transcript grows', async () => {
    const early = (await readTranscriptTurns(transcript(cli, TURN_STARTS[cli][2]))).map((turn) => turn.key);
    const late = (await readTranscriptTurns(transcript(cli))).map((turn) => turn.key);

    expect(early).toHaveLength(2);
    expect(late.slice(0, 2)).toEqual(early);
    expect(new Set(late).size).toBe(4);
  });

  it('reads a transcript caught mid-write without throwing: the unfinished turn has no answer yet', async () => {
    const lines = fixtureLines(cli);
    const turns = await readTranscriptTurns(transcript(cli, lines.length - 1, lines.at(-1)!.slice(0, 40)));

    expect(turns.map((turn) => turn.answer)).toEqual([...ANSWERS.slice(0, 3), '']);
  });

  it('reads only the tail of a long transcript, and finds the same turns there', async () => {
    const file = transcript(cli);
    const whole = await readTranscriptTurns(file);
    let bytesRead = 0;

    const tail = await readTranscriptTurns(file, { wanted: 2, chunkBytes: 256, onRead: (bytes) => { bytesRead = bytes; } });

    expect(bytesRead).toBeLessThan(fs.statSync(file).size);
    expect(tail.length).toBeGreaterThanOrEqual(2);
    expect(tail).toEqual(whole.slice(-tail.length));
  });

  it('keeps a record the tail read happens to begin on', async () => {
    const file = transcript(cli);
    const lastTurn = fixtureLines(cli).slice(TURN_STARTS[cli][3]).join('\n').length + 1;

    const tail = await readTranscriptTurns(file, { wanted: 1, chunkBytes: lastTurn });

    expect(tail.map((turn) => turn.request)).toEqual([QUESTIONS[3]]);
  });

  it('reads back as far as a named turn, with the turns before it', async () => {
    const file = transcript(cli);
    const whole = await readTranscriptTurns(file);

    const tail = await readTranscriptTurns(file, { target: whole[1].key, chunkBytes: 256 });

    expect(tail).toEqual(whole);
  });
});

describe('auto-save for CLI sessions', () => {
  type Body = { messages: Array<{ role: string; content: string }> };
  const PORT_ATOM = 'NEW\nTLDR: vite dev server runs on 5173\nCONTENT: The renderer dev server listens on port 5173.';

  let server: http.Server;
  let baseUrl: string;
  let judgePrompts: string[];
  let judge: (prompt: string) => string;

  beforeEach(async () => {
    judgePrompts = [];
    judge = () => 'NOTHING';
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Body;
        expect(body.messages[0].content).toBe(JUDGE_SYSTEM_PROMPT);
        judgePrompts.push(body.messages[1].content);
        let answer: string | undefined;
        try { answer = judge(body.messages[1].content); } catch { /* answered as a server error */ }
        res.writeHead(answer === undefined ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer === undefined ? { error: 'boom' } : { choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function setup(options: { autoSave?: boolean } = {}) {
    const transcripts = new Map<string, string>();
    /** Runs in place of each pause before a read, with the count of pauses so far. */
    const pause = { run: (_count: number) => {} };
    let pauses = 0;
    let tick = 0;
    const memory = new MemoryManager({ resolveSessionProject: () => 'p-a', now: () => ++tick });
    const host = new ApiSessionHost({
      dispatchTool: async () => ({ ok: true }),
      postChat: async () => {},
      mcpTools: () => [],
      listSkills: () => [],
      getMission: () => undefined,
      recordToolRequest: () => {},
      emitHook: () => {},
      historyDir: dir,
      createMemory: () => ({ id: 'm' }),
      linkMemory: () => {},
    });
    const api = { baseUrl, model: 'qwen', allowedTools: [], slots: 1, handshake: false };
    const recorder = new AutoMemoryRecorder({
      runner: new RecordingModelRunner({
        getRecordingModel: () => 'api-local',
        resolveModel: (ref) => (ref === 'api-local' ? { id: ref, kind: 'api', api } : null),
        backends: { api: apiSilentBackend(host) },
      }),
      isEnabled: () => options.autoSave ?? true,
      isLive: () => true,
      getMission: () => 'Get the renderer dev loop working',
      listBound: (sessionId) => memory.listBoundForSession(sessionId),
      create: (sessionId, atom) => { memory.createForSession(sessionId, { ...atom, sessionBound: true }); },
      update: (sessionId, id, atom) => { memory.updateForSession(sessionId, id, atom); },
    });
    const cli = new CliAutoMemory({
      isEnabled: () => options.autoSave ?? true,
      getTranscriptPath: (sessionId) => transcripts.get(sessionId),
      record: (sessionId, turns) => recorder.recordTurns(sessionId, turns),
      wait: async () => { pause.run(++pauses); },
      attempts: 3,
    });
    return { memory, cli, transcripts, pause };
  }

  it('judges the turn a Stop ended and saves a memory bound to that session', async () => {
    judge = () => PORT_ATOM;
    const { memory, cli, transcripts } = setup();
    transcripts.set('s1', transcript('claude'));

    expect(await cli.turnEnded('s1')).toBe('created');

    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain('MISSION (framing only, never save it):\nGet the renderer dev loop working');
    expect(judgePrompts[0]).toContain(`USER: ${QUESTIONS[2]}\nASSISTANT: ${ANSWERS[2]}`);
    expect(judgePrompts[0]).toContain(`TARGET (the newest turn):\nUSER: ${QUESTIONS[3]}\nASSISTANT: ${ANSWERS[3]}`);
    expect(memory.listBoundForSession('s1')).toMatchObject([{
      tldr: 'vite dev server runs on 5173',
      sessionId: 's1',
      sessionBound: true,
      sourceTurn: (await readTranscriptTurns(transcripts.get('s1')!))[3].key,
    }]);
    expect(memory.listRecordsForSession('s2')).toEqual([]);
  });

  it('shows the judge the target turn\'s tool calls and results', async () => {
    const { cli, transcripts } = setup();
    transcripts.set('s1', transcript('codex', TURN_STARTS.codex[3]));

    await cli.turnEnded('s1');

    expect(judgePrompts[0]).toMatch(/TARGET \(the newest turn\):\nUSER: why did the build fail\?\nTOOL CALL: exec npm run build\nTOOL RESULT: Exit code 1\nEBUSY[^\n]*\nASSISTANT: The build failed/);
  });

  it.each([
    ['the session has no hooks, so no transcript', {}, false],
    ['auto-save is off', { autoSave: false }, true],
  ] as const)('makes no judge request when %s', async (_name, options, hooked) => {
    judge = () => PORT_ATOM;
    const { memory, cli, transcripts } = setup(options);
    if (hooked) transcripts.set('s1', transcript('claude'));

    expect(await cli.turnEnded('s1')).toBe('off');
    expect(judgePrompts).toEqual([]);
    expect(memory.listBoundForSession('s1')).toEqual([]);
  });

  it('writes one memory, not two, for two Stops over overlapping turns', async () => {
    judge = (prompt) => (prompt.includes('[1] vite dev server runs on 5173')
      ? 'UPDATE 1\nTLDR: vite dev server runs on 5173, preview on 4173\nCONTENT: Dev 5173, preview 4173.'
      : PORT_ATOM);
    const { memory, cli, transcripts } = setup();
    transcripts.set('s1', transcript('copilot', TURN_STARTS.copilot[3]));

    expect(await cli.turnEnded('s1')).toBe('created');
    transcript('copilot');
    expect(await cli.turnEnded('s1')).toBe('updated');

    expect(judgePrompts[1]).toContain('ALREADY SAVED (from the turns above, newest first):\n[1] vite dev server runs on 5173');
    expect(memory.listBoundForSession('s1')).toMatchObject([{ tldr: 'vite dev server runs on 5173, preview on 4173' }]);
  });

  it('does not judge the same finished turn twice', async () => {
    judge = () => PORT_ATOM;
    const { memory, cli, transcripts } = setup();
    transcripts.set('s1', transcript('claude'));

    expect(await cli.turnEnded('s1')).toBe('created');
    expect(await cli.turnEnded('s1')).toBe('off');

    expect(judgePrompts).toHaveLength(1);
    expect(memory.listBoundForSession('s1')).toHaveLength(1);
  });

  it('never judges a turn whose answer is still being written', async () => {
    judge = () => PORT_ATOM;
    const { cli, transcripts } = setup();
    const lines = fixtureLines('claude');
    // Only turn 4's request is in, and its answer is half written.
    const file = path.join(dir, 'torn.jsonl');
    transcripts.set('s1', file);
    fs.writeFileSync(file, `${lines[28]}\n${lines[29].slice(0, 40)}`);

    expect(await cli.turnEnded('s1')).toBe('off');
    expect(judgePrompts).toEqual([]);

    fs.writeFileSync(file, `${lines[28]}\n${lines[29]}\n`);
    expect(await cli.turnEnded('s1')).toBe('created');
    expect(judgePrompts).toHaveLength(1);
  });

  it('does not take text written before a tool call for the answer of a turn still being written', async () => {
    judge = () => PORT_ATOM;
    const { cli, transcripts, pause } = setup();
    // Up to "I will check the vite config." and its tool call: the turn has text, not its answer.
    transcripts.set('s1', transcript('codex', 10));
    pause.run = (count) => { if (count === 2) transcript('codex', TURN_STARTS.codex[1]); };

    expect(await cli.turnEnded('s1')).toBe('created');

    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(`ASSISTANT: ${ANSWERS[0]}`);
    expect(judgePrompts[0]).not.toContain('ASSISTANT: I will check the vite config.');
  });

  it('judges the turn its Stop ended, though the next turn is running by the time it reads', async () => {
    judge = (prompt) => (prompt.includes('[1] ') ? 'NOTHING' : PORT_ATOM);
    const { memory, cli, transcripts } = setup();
    const lines = fixtureLines('copilot');
    const file = path.join(dir, 'live.jsonl');
    const second = lines.slice(TURN_STARTS.copilot[1], TURN_STARTS.copilot[2]);
    // The next turn so far: a request, a tool call and its result, then text with another tool call.
    const running = lines.slice(TURN_STARTS.copilot[0], 12);
    transcripts.set('s1', file);
    fs.writeFileSync(file, `${second.join('\n')}\n`);

    // The next turn is written the moment the hook is answered: before the Stop's own read of the log.
    const pass = cli.turnEnded('s1');
    fs.appendFileSync(file, `${running.join('\n')}\n`);

    expect(await pass).toBe('created');

    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(`TARGET (the newest turn):\nUSER: ${QUESTIONS[1]}\nASSISTANT: ${ANSWERS[1]}`);
    expect(judgePrompts[0]).not.toContain(QUESTIONS[0]);
    expect(memory.listBoundForSession('s1')).toHaveLength(1);
  });

  it('judges each turn at its own Stop, with the turns before it as context', async () => {
    const { cli, transcripts } = setup();
    for (const end of [...TURN_STARTS.claude.slice(1), undefined]) {
      transcripts.set('s1', transcript('claude', end));
      await cli.turnEnded('s1');
    }

    const targets = judgePrompts.map((prompt) => /TARGET \(the newest turn\):\nUSER: ([^\n]*)/.exec(prompt)![1]);
    expect(targets).toEqual(QUESTIONS);
    expect(judgePrompts[3]).toContain(`CONTEXT (earlier turns, oldest first):\n\nUSER: ${QUESTIONS[0]}`);
  });

  it('handles two Stops of one session one at a time', async () => {
    judge = () => PORT_ATOM;
    const { memory, cli, transcripts } = setup();
    transcripts.set('s1', transcript('claude'));

    expect(await Promise.all([cli.turnEnded('s1'), cli.turnEnded('s1')])).toEqual(['created', 'off']);

    expect(judgePrompts).toHaveLength(1);
    expect(memory.listBoundForSession('s1')).toHaveLength(1);
  });

  it('judges a turn again at the next Stop when the judge request failed', async () => {
    const { cli, transcripts } = setup();
    transcripts.set('s1', transcript('claude'));
    judge = () => { throw new Error('model unloaded'); };

    expect(await cli.turnEnded('s1')).toBe('failed');
    judge = () => 'NOTHING';
    expect(await cli.turnEnded('s1')).toBe('nothing');
    expect(await cli.turnEnded('s1')).toBe('off');

    expect(judgePrompts).toHaveLength(2);
  });

  it('survives a transcript that has gone missing', async () => {
    const { cli, transcripts } = setup();
    transcripts.set('s1', path.join(dir, 'gone.jsonl'));

    expect(await cli.turnEnded('s1')).toBe('off');
    expect(judgePrompts).toEqual([]);
  });

  it('forgets a closed session, so a session reusing the id is judged afresh', async () => {
    const { cli, transcripts } = setup();
    transcripts.set('s1', transcript('claude'));

    await cli.turnEnded('s1');
    cli.forget('s1');
    await cli.turnEnded('s1');

    expect(judgePrompts).toHaveLength(2);
  });
});
