import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmSessionService } from '../../src/mcp/services/helm-session-service.js';
import { ApiSessionHost } from '../../src/session/api/api-session-host.js';
import { SessionManager } from '../../src/session/manager.js';

describe('ApiSessionHost context size', () => {
  it('exposes the model server’s latest context token count for a live session', async () => {
    const historyDir = mkdtempSync(join(tmpdir(), 'helm-api-context-'));
    const host = new ApiSessionHost({
      dispatchTool: async () => undefined,
      mcpTools: () => [],
      listSkills: () => [],
      getMission: () => undefined,
      createMemory: () => ({ id: 'memory' }),
      linkMemory: () => undefined,
      recordToolRequest: () => undefined,
      postChat: async () => undefined,
      emitHook: () => undefined,
      historyDir,
      createClient: () => ({
        complete: async () => ({ message: { content: 'answer' }, usage: { total_tokens: 12_345 } }),
      }),
    });

    const process = host.create({
      sessionId: 'api-session',
      sessionName: 'API session',
      cliSessionName: 'api-session',
      api: { baseUrl: 'http://localhost/v1', model: 'test', allowedTools: [], handshake: false },
    });
    const sessionManager = new SessionManager();
    sessionManager.addSession({
      id: 'api-session', name: 'API session', cliType: 'api', apiTool: true,
    } as any, true);
    const sessionService = new HelmSessionService(
      sessionManager,
      { has: () => true } as any,
      { getCliTypeEntry: () => ({ contextWindow: 100_000 }), getCliTypeLabel: (cliType: string) => cliType } as any,
      { getForDirectory: () => [] } as any,
    );
    sessionService.setApiContextSizeLookup((sessionId) => host.getContextSize(sessionId));
    try {
      process.write('question\r');
      await vi.waitFor(() => {
        expect(sessionService.getSession('api-session')?.context).toEqual({
          known: true,
          tokens: 12_345,
          window: 100_000,
          percent: 12,
          source: 'api',
        });
      });
    } finally {
      process.kill();
      await new Promise(resolve => setTimeout(resolve, 0));
      rmSync(historyDir, { recursive: true, force: true });
    }
  });
});
