/**
 * Session-authenticated local endpoints used by CLI integrations.
 *
 * Real HTTP server, real bearer/session-token auth. The /hooks route must
 * accept ONLY session tokens (a hook belongs to one spawned session), and its
 * reply must always be a no-op decision — G1 observes, it never steers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalhostMcpServer, type LocalhostMcpServerOptions } from '../src/mcp/localhost-mcp-server';
import { HookReceiver } from '../src/session/hooks/hook-receiver';
import { mintSessionAuthToken } from '../src/mcp/session-auth';
import type { HelmControlService } from '../src/mcp/helm-control-service';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const servers: LocalhostMcpServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

async function makeServer(
  hooks: HookReceiver,
  onClaudeStatuslineUsage?: LocalhostMcpServerOptions['onClaudeStatuslineUsage'],
): Promise<{ port: number; sessionToken: string }> {
  const service = {} as HelmControlService; // /hooks never touches the tool service
  const server = new LocalhostMcpServer(service, {
    token: 'base-token',
    port: 0,
    onClaudeStatuslineUsage,
  }, undefined, hooks);
  servers.push(server);
  await server.start();
  return {
    port: (server.getAddress() as AddressInfo).port,
    sessionToken: mintSessionAuthToken('base-token', 'session-1', 'worker'),
  };
}

function post(port: number, path: string, token: string | null, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('POST /hooks', () => {
  it('accepts a session token, correlates the event and replies with a no-op decision', async () => {
    const receiver = new HookReceiver();
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const { port, sessionToken } = await makeServer(receiver);

    const response = await post(
      port,
      '/hooks',
      sessionToken,
      JSON.stringify({ cli: 'claude', event: 'Stop', payload: { session_id: 'c1' } }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cli: 'claude', event: 'Stop', helmSessionId: 'session-1' });
  });

  it('rejects the shared bearer token — only session tokens may post hooks', async () => {
    const receiver = new HookReceiver();
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const { port } = await makeServer(receiver);

    const response = await post(port, '/hooks', 'base-token', JSON.stringify({ cli: 'claude', event: 'Stop', payload: {} }));

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects a missing or wrong token with 401', async () => {
    const receiver = new HookReceiver();
    const { port } = await makeServer(receiver);

    expect((await post(port, '/hooks', null, '{}')).status).toBe(401);
    expect((await post(port, '/hooks', 'helm_session_v1.forged.x.y', '{}')).status).toBe(401);
  });

  it('rejects invalid JSON with 400', async () => {
    const receiver = new HookReceiver();
    const { port, sessionToken } = await makeServer(receiver);

    const response = await post(port, '/hooks', sessionToken, 'not json');
    expect(response.status).toBe(400);
  });

  it('answers 200 without emitting when the event name is unknown', async () => {
    const receiver = new HookReceiver();
    const seen: unknown[] = [];
    receiver.on('hook', (event) => seen.push(event));

    const { port, sessionToken } = await makeServer(receiver);

    const response = await post(
      port,
      '/hooks',
      sessionToken,
      JSON.stringify({ cli: 'claude', event: 'ConfigChange', payload: {} }),
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('still serves /mcp as before', async () => {
    const receiver = new HookReceiver();
    const { port } = await makeServer(receiver);

    const response = await post(port, '/mcp', 'base-token', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(response.status).toBe(200);
  });
});

describe('POST /context-usage', () => {
  it('accepts a session token and passes current tokens and the reported window to Helm', async () => {
    const reports: unknown[] = [];
    const { port, sessionToken } = await makeServer(new HookReceiver(), (sessionId, cliSessionId, usage) => {
      reports.push({ sessionId, cliSessionId, usage });
      return true;
    });
    const response = await post(port, '/context-usage', sessionToken, JSON.stringify({
      session_id: 'claude-session-1',
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        context_window_size: 200_000,
      },
    }));

    expect(response.status).toBe(204);
    expect(reports).toEqual([{
      sessionId: 'session-1',
      cliSessionId: 'claude-session-1',
      usage: { contextTokens: 16_700, contextWindow: 200_000 },
    }]);
  });

  it('rejects the shared bearer and malformed payloads', async () => {
    const { port, sessionToken } = await makeServer(new HookReceiver());

    expect((await post(port, '/context-usage', 'base-token', '{}')).status).toBe(401);
    expect((await post(port, '/context-usage', sessionToken, 'not json')).status).toBe(400);
    expect((await post(port, '/context-usage', sessionToken, '{}')).status).toBe(400);
    expect((await post(port, '/context-usage', sessionToken, JSON.stringify({
      context_window: { total_input_tokens: 100, total_output_tokens: 0 },
    }))).status).toBe(400);
  });

  it('passes an empty post-compaction window through so Helm can clear stale usage', async () => {
    const reports: unknown[] = [];
    const { port, sessionToken } = await makeServer(new HookReceiver(), (_sessionId, _cliSessionId, usage) => {
      reports.push(usage);
    });
    const response = await post(port, '/context-usage', sessionToken, JSON.stringify({
      session_id: 'claude-session-1',
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        current_usage: null,
      },
    }));

    expect(response.status).toBe(204);
    expect(reports).toEqual([null]);
  });
});
