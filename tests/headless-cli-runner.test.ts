/**
 * HeadlessCliRunner: a real CLI as the recording model. One run = one row-less
 * PTY in the real PtyManager, the prompt in a file, the reply in a file.
 *
 * The "CLI" here is a tiny real node script run through a real node-pty shell:
 * the things under test are the shell line, the exit code, the kill on timeout
 * and the fact that nothing about the run looks like a session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeadlessCliRunner } from '../src/session/headless-cli-runner.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { SessionManager } from '../src/session/manager.js';

const STUB = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [mode, marker] = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
if (marker) appendFileSync(marker, 'start ' + process.pid + '\\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { console.error('stub: no such model'); process.exit(3); }
else if (mode === 'env') process.stdout.write('id=[' + (process.env.HELM_SESSION_ID ?? '') + '] url=[' + (process.env.HELM_HOOK_URL ?? '') + '] ctx=[' + (process.env.HELM_CONTEXT_USAGE_URL ?? '') + '] own=[' + (process.env.STUB_OWN ?? '') + ']');
else setTimeout(() => {
  process.stdout.write('REPLY<' + prompt + '>');
  if (marker) appendFileSync(marker, 'end ' + process.pid + '\\n');
}, mode === 'slow' ? 400 : 0);
`;

const HELM_ENV = ['HELM_SESSION_ID', 'HELM_HOOK_URL', 'HELM_CONTEXT_USAGE_URL', 'HELM_MCP_TOKEN', 'HELM_MCP_URL', 'HELM_SESSION_NAME'] as const;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('HeadlessCliRunner', () => {
  let dir: string;
  let stub: string;
  let marker: string;
  let pty: PtyManager;
  let events: string[];
  let savedEnv: Record<string, string | undefined>;

  const command = (mode: string, withMarker = false): string =>
    `node "${stub}" ${mode}${withMarker ? ` "${marker}"` : ''} < "{promptFile}" > "{outputFile}"`;
  const model = (headlessCommand: string | undefined, id = 'cli-a', env?: Record<string, string>) =>
    ({ id, kind: 'cli' as const, headlessCommand, env });
  const runner = (timeoutMs = 20_000) => new HeadlessCliRunner({ pty, workDir: path.join(dir, 'work'), timeoutMs });
  const leftovers = (): string[] => fs.existsSync(path.join(dir, 'work')) ? fs.readdirSync(path.join(dir, 'work')) : [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-headless-'));
    stub = path.join(dir, 'stub-cli.mjs');
    marker = path.join(dir, 'marker.log');
    fs.writeFileSync(stub, STUB, 'utf8');
    pty = new PtyManager();
    events = [];
    pty.on('data', (id: string) => events.push(`data ${id}`));
    pty.on('exit', (id: string) => events.push(`exit ${id}`));
    savedEnv = Object.fromEntries(HELM_ENV.map((key) => [key, process.env[key]]));
  });

  afterEach(async () => {
    pty.killAll();
    for (const key of HELM_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    // A shell killed a moment ago still holds its working directory.
    await until(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
    });
  });

  it('hands the system text and the prompt to the CLI and returns what it printed', async () => {
    const text = await runner().run(model(command('echo')), { system: 'You judge.', prompt: 'Line "one"\nLine two & <three>' });

    expect(text).toBe('REPLY<You judge.\n\nLine "one"\nLine two & <three>>');
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it('is no session: nothing is broadcast, no PTY stays, the session list is untouched', async () => {
    const sessions = new SessionManager();
    const seen: string[] = [];
    const during = runner().run(model(command('slow')), { prompt: 'p' });
    await until(() => pty.getSessionIds().length > 0);
    seen.push(...pty.getSessionIds());

    await during;

    expect(seen).toHaveLength(1);
    expect(events).toEqual([]);
    expect(pty.getSessionIds()).toEqual([]);
    expect(sessions.getSessionCount()).toBe(0);
  }, 30_000);

  it('blanks the Helm session variables, so the hook shim of the CLI it runs stays silent', async () => {
    process.env.HELM_SESSION_ID = 'outer-session';
    process.env.HELM_HOOK_URL = 'http://127.0.0.1:1/hooks';

    const text = await runner().run(
      model(command('env'), 'cli-a', { STUB_OWN: 'kept', HELM_SESSION_ID: 'from-type-env' }),
      { prompt: 'p' },
    );

    expect(text).toBe('id=[] url=[] ctx=[] own=[kept]');
  }, 30_000);

  const python = ['python', 'python3'].find((name) => spawnSync(name, ['--version'], { timeout: 10_000 }).status === 0);

  it.skipIf(!python)('reaches no hook endpoint when the CLI fires its Stop hook', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url ?? ''); res.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.HELM_SESSION_ID = 'outer-session';
    process.env.HELM_MCP_TOKEN = 'token';
    process.env.HELM_HOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    const shim = path.join(process.cwd(), 'src', 'config', 'hooks', 'helm-hook-shim.py');

    try {
      const text = await runner().run(
        model(`${python} "${shim}" claude Stop < "{promptFile}" > "{outputFile}"`),
        { prompt: '{"hook_event_name":"Stop"}' },
      );
      expect(text).toBe('');
      expect(requests).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);

  it('kills a run that outlives the timeout and leaves nothing behind', async () => {
    await expect(runner(2500).run(model(command('hang', true)), { prompt: 'p' })).rejects.toThrow(/timed out after 2\.5 s/);

    const pid = Number(/start (\d+)/.exec(fs.readFileSync(marker, 'utf8'))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !alive(pid))).toBe(true);
    expect(pty.getSessionIds()).toEqual([]);
    expect(await until(() => leftovers().length === 0)).toBe(true);
  }, 30_000);

  it('kills the run when the caller aborts', async () => {
    const abort = new AbortController();
    const run = runner().run(model(command('hang', true)), { prompt: 'p', signal: abort.signal });
    await until(() => fs.existsSync(marker));
    abort.abort();

    await expect(run).rejects.toThrow(/aborted/);
    expect(pty.getSessionIds()).toEqual([]);
  }, 30_000);

  it('starts nothing when the caller aborts while the prompt file is being written', async () => {
    const abort = new AbortController();
    const spawned: string[] = [];
    const watched = { spawn: (options: Parameters<PtyManager['spawn']>[0]) => { spawned.push(options.sessionId); return pty.spawn(options); }, kill: (id: string) => pty.kill(id) };
    const run = new HeadlessCliRunner({ pty: watched, workDir: path.join(dir, 'work'), timeoutMs: 20_000 })
      .run(model(command('hang')), { prompt: 'p'.repeat(4_000_000), signal: abort.signal });
    // The pass has left the queue and is on the disk, not yet in a PTY.
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();

    await expect(run).rejects.toThrow(/aborted/);
    expect(spawned).toEqual([]);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it('runs two passes of one CLI type one after the other', async () => {
    const one = runner();
    const replies = await Promise.all([
      one.run(model(command('slow', true)), { prompt: 'first' }),
      one.run(model(command('slow', true)), { prompt: 'second' }),
    ]);

    expect(replies).toEqual(['REPLY<first>', 'REPLY<second>']);
    const order = fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  }, 30_000);

  it('drops a pass aborted in the queue at once, without letting the next one jump the queue', async () => {
    const one = runner();
    const abort = new AbortController();
    const first = one.run(model(command('slow', true)), { prompt: 'first' });
    const dropped = one.run(model(command('echo', true)), { prompt: 'dropped', signal: abort.signal });
    const third = one.run(model(command('slow', true)), { prompt: 'third' });
    let firstDone = false;
    void first.then(() => { firstDone = true; });

    abort.abort();
    await expect(dropped).rejects.toThrow(/aborted/);
    expect(firstDone).toBe(false);

    expect(await Promise.all([first, third])).toEqual(['REPLY<first>', 'REPLY<third>']);
    const order = fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  }, 30_000);

  it('keeps the user\'s directory names out of the shell line', async () => {
    // cmd.exe expands %VAR% even inside quotes; a unix shell runs $(...) there.
    const odd = new HeadlessCliRunner({ pty, workDir: path.join(dir, 'odd %PATH% $(name) dir'), timeoutMs: 20_000 });

    await expect(odd.run(model(command('echo')), { prompt: 'p' })).resolves.toBe('REPLY<p>');
  }, 30_000);

  it('does not make one CLI type wait for another', async () => {
    const one = runner();
    const abort = new AbortController();
    const hung = one.run(model(command('hang'), 'cli-a'), { prompt: 'p', signal: abort.signal });

    await expect(one.run(model(command('echo'), 'cli-b'), { prompt: 'p' })).resolves.toBe('REPLY<p>');
    abort.abort();
    await expect(hung).rejects.toThrow(/aborted/);
  }, 30_000);

  it('carries on with the queue after a failed pass', async () => {
    const one = runner();
    const failed = one.run(model(command('fail')), { prompt: 'p' });
    const next = one.run(model(command('echo')), { prompt: 'p' });

    await expect(failed).rejects.toThrow(/exited with code 1.*stub: no such model/s);
    await expect(next).resolves.toBe('REPLY<p>');
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it('refuses a model with no usable headless command without starting anything', async () => {
    await expect(runner().run(model(undefined), { prompt: 'p' })).rejects.toThrow(/no headless command/);
    await expect(runner().run(model('claude -p'), { prompt: 'p' })).rejects.toThrow(/\{promptFile\} and \{outputFile\}/);
    expect(pty.getSessionIds()).toEqual([]);
  });
});
