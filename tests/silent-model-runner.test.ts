/**
 * The silent runner: one tool-less request against the recording model picked
 * in Settings, through that API tool's slots, with no session behind it.
 *
 * Real ApiSessionHost + the real OpenAI-compatible client, pointed at a local
 * HTTP server standing in for llama-server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ApiSessionHost } from '../src/session/api/api-session-host.js';
import { RecordingModelRunner, apiSilentBackend, type RecordingModel } from '../src/session/silent-model-runner.js';

interface SeenRequest {
  body: { messages: Array<{ role: string; content: string }>; tools?: unknown };
  authorization?: string;
  /** Answer the request; until called the model is "still thinking". */
  reply: (status?: number, content?: string) => void;
}

describe('RecordingModelRunner', () => {
  let dir: string;
  let server: http.Server;
  let baseUrl: string;
  let seen: SeenRequest[];
  /** When false each request waits for its test to call reply(). */
  let autoReply: boolean;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-runner-'));
    seen = [];
    autoReply = true;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const reply = (status = 200, content = 'KEEP: vite port is 5173') => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content }, finish_reason: 'stop' }] } : { error: 'boom' }));
        };
        seen.push({ body: JSON.parse(raw), authorization: req.headers.authorization, reply });
        if (autoReply) reply();
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

  function setup(picked: string, extraModels: Record<string, RecordingModel> = {}) {
    const dispatched: string[] = [];
    const hooks: string[] = [];
    const chats: string[] = [];
    const host = new ApiSessionHost({
      dispatchTool: async (name) => { dispatched.push(name); return { ok: true }; },
      postChat: async (_sessionId, message) => { chats.push(message); },
      mcpTools: () => [],
      listSkills: () => [],
      getMission: () => undefined,
      recordToolRequest: () => {},
      emitHook: (event) => hooks.push(event.event),
      historyDir: dir,
      createMemory: () => ({ id: 'm' }),
      linkMemory: () => {},
    });
    const api = { baseUrl, model: 'qwen', allowedTools: ['Read'], apiKeyEnv: 'LOCAL_KEY', slots: 1, handshake: false };
    const models: Record<string, RecordingModel> = {
      'api-local': { id: 'api-local', kind: 'api', api, env: { LOCAL_KEY: 'sekret' } },
      'cli-claude': { id: 'cli-claude', kind: 'cli' },
      ...extraModels,
    };
    const runner = new RecordingModelRunner({
      getRecordingModel: () => picked,
      resolveModel: (ref) => models[ref] ?? null,
      backends: { api: apiSilentBackend(host) },
    });
    return { host, runner, api, dispatched, hooks, chats };
  }

  it('sends one tool-less request to the picked model and returns its text', async () => {
    const { runner, dispatched, hooks, chats } = setup('api-local');

    const result = await runner.runSilently({ system: 'You judge memories.', prompt: 'Turn: vite runs on 5173' });

    expect(result).toEqual({ status: 'ok', text: 'KEEP: vite port is 5173' });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.messages).toEqual([
      { role: 'system', content: 'You judge memories.' },
      { role: 'user', content: 'Turn: vite runs on 5173' },
    ]);
    expect(seen[0].body.tools).toBeUndefined();
    expect(seen[0].authorization).toBe('Bearer sekret');
    // Silent: no session was created, no hook fired, nothing reached the chat.
    expect(dispatched).toEqual([]);
    expect(hooks).toEqual([]);
    expect(chats).toEqual([]);
  });

  it('is inert with no model picked and makes no request', async () => {
    const { runner } = setup('');

    expect(await runner.runSilently({ prompt: 'anything' })).toEqual({ status: 'inert', reason: 'No recording model is picked' });
    expect(seen).toEqual([]);
  });

  it('reports a failed request instead of throwing, and frees the slot', async () => {
    const { runner } = setup('api-local');
    autoReply = false;

    const failing = runner.runSilently({ prompt: 'first' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    seen[0].reply(500);
    expect(await failing).toEqual({ status: 'failed', error: expect.stringContaining('API 500') });

    // slots: 1 — a leaked slot would leave this second request queued forever.
    autoReply = true;
    expect(await runner.runSilently({ prompt: 'second' })).toMatchObject({ status: 'ok' });
  });

  it('queues behind a session of the same API tool for its slot', async () => {
    const { host, runner, api } = setup('api-local');
    autoReply = false;
    const proc = host.create({ sessionId: 's1', cliType: 'api-local', sessionName: 'worker', cliSessionName: 'abc-1', api, env: { LOCAL_KEY: 'sekret' } });
    proc.write('do real work\r');
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const silent = runner.runSilently({ prompt: 'judge this' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(1);

    seen[0].reply(200, 'work done');
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1].body.messages.slice(-1)[0]).toEqual({ role: 'user', content: 'judge this' });
    seen[1].reply();
    expect(await silent).toMatchObject({ status: 'ok' });
    proc.kill();
  });

  it('gives up its place in the queue when aborted before a slot frees', async () => {
    const { host, runner, api } = setup('api-local');
    autoReply = false;
    const proc = host.create({ sessionId: 's1', cliType: 'api-local', sessionName: 'worker', cliSessionName: 'abc-2', api });
    proc.write('a long request\r');
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const abort = new AbortController();
    const silent = runner.runSilently({ prompt: 'judge this', signal: abort.signal });
    abort.abort();

    // Answered while the session still holds the only slot, and without a request of its own.
    expect(await silent).toEqual({ status: 'failed', error: 'Request aborted' });
    seen[0].reply(200, 'work done');
    autoReply = true;
    expect(await runner.runSilently({ prompt: 'next' })).toMatchObject({ status: 'ok' });
    expect(seen.map((request) => request.body.messages.slice(-1)[0].content)).not.toContain('judge this');
    proc.kill();
  });

  it('fails a real CLI type when no headless backend is wired, without a request', async () => {
    const { runner } = setup('cli-claude');

    expect(await runner.runSilently({ prompt: 'anything' })).toEqual({
      status: 'failed',
      error: 'Recording model cli-claude needs the headless runner',
    });
    expect(seen).toEqual([]);
  });

  it('fails when the picked model no longer exists', async () => {
    const { runner } = setup('deleted-type');

    expect(await runner.runSilently({ prompt: 'anything' })).toEqual({
      status: 'failed',
      error: 'Recording model deleted-type no longer exists',
    });
  });

  it('treats an empty answer as a failure rather than an empty memory', async () => {
    const { runner } = setup('api-local');
    autoReply = false;

    const run = runner.runSilently({ prompt: 'first' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    seen[0].reply(200, '   ');

    expect(await run).toEqual({ status: 'failed', error: 'The recording model returned no text' });
  });
});
