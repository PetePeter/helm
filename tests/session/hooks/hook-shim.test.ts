/**
 * helm-hook-shim.py — the ONE transport all three CLIs share.
 *
 * Runs the real script under a real Python interpreter (probed exactly the way
 * the installer probes). The failure paths are the whole point: every one of
 * them must be silent and exit 0, because exit 2 DENIES on supported events —
 * a hook that crashes must never brick a CLI session.
 */

import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SHIM_PATH = join(process.cwd(), 'src', 'config', 'hooks', 'helm-hook-shim.py');
const CANDIDATES: Array<{ command: string; args: string[] }> = [
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
  { command: 'py', args: ['-3'] },
];

let python: { command: string; args: string[] } | null = null;

// Probed synchronously at collection time so the suite can skip itself whole.
for (const candidate of CANDIDATES) {
  const probe = spawnSync(candidate.command, [...candidate.args, '--version'], { timeout: 10_000 });
  if (probe.status === 0) {
    python = candidate;
    break;
  }
}

/** Run the shim with the given env and stdin; resolves { code, stdout, stderr }. */
function runShim(
  env: Record<string, string>,
  stdin: string,
  args = ['claude', 'PreToolUse'],
  shimPath = SHIM_PATH,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Helm injects its own session vars into every process it spawns — this
    // test process included. Strip them so each case controls its presence.
    const base = { ...process.env } as Record<string, string | undefined>;
    for (const key of ['HELM_SESSION_ID', 'HELM_SESSION_NAME', 'HELM_MCP_TOKEN', 'HELM_MCP_URL', 'HELM_HOOK_URL', 'HELM_CONTEXT_USAGE_URL']) {
      delete base[key];
    }
    const child = execFile(
      python!.command,
      [...python!.args, shimPath, ...args],
      { env: { ...base, ...env } as NodeJS.ProcessEnv, timeout: 20_000 },
      (error, stdout, stderr) => {
        // execFile surfaces a non-zero exit as an error object; the code is the point.
        const code = error && typeof (error as { code?: number }).code === 'number' ? (error as { code: number }).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end(stdin);
    child.on('error', reject);
  });
}

async function runStatusline(
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-statusline-'));
  const shimPath = join(dir, 'helm-hook-shim.py');
  const originalPath = join(dir, 'original-statusline.py');
  copyFileSync(SHIM_PATH, shimPath);
  writeFileSync(originalPath, "import json, sys\nprint('USER:' + json.load(sys.stdin)['session_id'])\n", 'utf8');
  const originalCommand = [python!.command, ...python!.args, originalPath].map((part) => `"${part}"`).join(' ');
  writeFileSync(join(dir, 'helm-claude-statusline.json'), JSON.stringify({ command: originalCommand }), 'utf8');
  try {
    return await runShim(env, stdin, ['statusline'], shimPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A local stand-in for Helm's /hooks endpoint that records what reached it. */
async function startRecordingServer(reply: string): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(python === null)('helm-hook-shim.py', () => {
  it('is shipped where the installer expects it', () => {
    const source = readFileSync(SHIM_PATH, 'utf8');
    expect(source).toContain('HELM_SESSION_ID');
    expect(source).toContain('HELM_HOOK_URL');
  });

  it('exits silently doing nothing when HELM_SESSION_ID is absent — no request is made', async () => {
    const helm = await startRecordingServer('{}');

    const result = await runShim({ HELM_HOOK_URL: helm.url, HELM_MCP_TOKEN: 'tok' }, '{"hook_event_name":"PreToolUse"}');
    await helm.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(helm.requests).toHaveLength(0);
  });

  it('exits silently with code 0 when Helm is unreachable', async () => {
    // A loopback port with no listener: connection refused, immediately.
    const result = await runShim(
      { HELM_SESSION_ID: 's1', HELM_HOOK_URL: 'http://127.0.0.1:9/hooks', HELM_MCP_TOKEN: 'tok' },
      '{"hook_event_name":"PreToolUse"}',
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits silently with code 0 on malformed stdin — never a traceback, never exit 2', async () => {
    const helm = await startRecordingServer('{}');

    const result = await runShim(
      { HELM_SESSION_ID: 's1', HELM_HOOK_URL: helm.url, HELM_MCP_TOKEN: 'tok' },
      'this is not json{{{',
    );
    await helm.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(helm.requests).toHaveLength(0);
  });

  it('does nothing without a bearer token even when a session id is present', async () => {
    const helm = await startRecordingServer('{}');

    const result = await runShim(
      { HELM_SESSION_ID: 's1', HELM_HOOK_URL: helm.url },
      '{"hook_event_name":"PreToolUse"}',
    );
    await helm.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(helm.requests).toHaveLength(0);
  });

  it('POSTs the envelope with cli and event, and prints Helm\'s reply on stdout', async () => {
    const helm = await startRecordingServer('{}');

    const result = await runShim(
      { HELM_SESSION_ID: 's1', HELM_HOOK_URL: helm.url, HELM_MCP_TOKEN: 'session-token' },
      '{"session_id":"c1","cwd":"/repo","hook_event_name":"PreToolUse"}',
    );
    await helm.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{}');
    expect(helm.requests).toHaveLength(1);
    expect(JSON.parse(helm.requests[0])).toEqual({
      cli: 'claude',
      event: 'PreToolUse',
      payload: { session_id: 'c1', cwd: '/repo', hook_event_name: 'PreToolUse' },
    });
  });

  it('reports Claude context and appends a compact badge after the original statusline output', async () => {
    const helm = await startRecordingServer('{}');
    const payload = {
      session_id: 'claude-1',
      model: { display_name: 'Opus' },
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        context_window_size: 200_000,
        used_percentage: 8,
      },
    };

    const result = await runStatusline({
      HELM_SESSION_ID: 'helm-1',
      HELM_CONTEXT_USAGE_URL: helm.url.replace('/hooks', '/context-usage'),
      HELM_MCP_TOKEN: 'session-token',
    }, JSON.stringify(payload));
    await helm.close();

    expect(result).toMatchObject({ code: 0, stdout: 'USER:claude-1 | CTX 8% 17k/200k\r\n', stderr: '' });
    expect(helm.requests.map((request) => JSON.parse(request))).toEqual([{
      session_id: 'claude-1',
      context_window: payload.context_window,
    }]);
  });

  it('uses input tokens for the percent fallback when Claude has not supplied used_percentage', async () => {
    const result = await runStatusline({ HELM_SESSION_ID: 'helm-1' }, JSON.stringify({
      session_id: 'claude-1',
      context_window: {
        total_input_tokens: 10_000,
        total_output_tokens: 90_000,
        context_window_size: 200_000,
        used_percentage: null,
      },
    }));

    expect(result).toMatchObject({ code: 0, stdout: 'USER:claude-1 | CTX 5% 100k/200k\r\n', stderr: '' });
  });

  it('does not show stale combined totals while Claude marks current usage empty', async () => {
    const result = await runStatusline({ HELM_SESSION_ID: 'helm-1' }, JSON.stringify({
      session_id: 'claude-1',
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        context_window_size: 200_000,
        current_usage: null,
      },
    }));

    expect(result).toMatchObject({ code: 0, stdout: 'USER:claude-1\r\n', stderr: '' });
  });

  it('still runs the original statusline command outside a Helm session', async () => {
    const result = await runStatusline({}, JSON.stringify({
      session_id: 'standalone',
      context_window: { total_input_tokens: 1000, total_output_tokens: 0, context_window_size: 200_000 },
    }));

    expect(result).toMatchObject({ code: 0, stdout: 'USER:standalone\r\n', stderr: '' });
  });
});
