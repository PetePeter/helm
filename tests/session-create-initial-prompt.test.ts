/**
 * session_create.initialPrompt — the phone's plan-scoped spawn hands the new
 * CLI a first instruction. It must ride the startup-safe contextText path
 * (delivered after the CLI's init sequence), and an omitted prompt must leave
 * the spawn exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnCalls: Array<Record<string, unknown>> = [];
vi.mock('../src/session/configured-session-spawn.js', () => ({
  spawnConfiguredSession: (params: Record<string, unknown>) => {
    spawnCalls.push(params);
    return { sessionId: 'new-sid' };
  },
}));

import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';

function makeService() {
  const configLoader = {
    getWorkingDirectories: vi.fn(() => [{ path: '/repo/main', name: 'main' }]),
    getCliTypes: vi.fn(() => []),
    resolveCliType: vi.fn((ref: string) => ({ id: ref, config: { name: 'Claude Code', spawnCommand: 'claude' } })),
  };
  return new HelmSessionService({} as any, {} as any, configLoader as any, {} as any);
}

describe('HelmSessionService.spawnCli — initialPrompt', () => {
  beforeEach(() => { spawnCalls.length = 0; });

  it('routes the prompt through the startup contextText delivery', () => {
    makeService().spawnCli('claude-code', '/repo/main', 'P-0001 Read', { initialPrompt: 'Read plan P-0001' });

    expect(spawnCalls[0].contextText).toBe('Read plan P-0001');
  });

  it('adds no contextText when the prompt is omitted or blank', () => {
    const service = makeService();
    service.spawnCli('claude-code', '/repo/main', undefined);
    service.spawnCli('claude-code', '/repo/main', undefined, { initialPrompt: '   ' });

    expect(spawnCalls[0]).not.toHaveProperty('contextText');
    expect(spawnCalls[1]).not.toHaveProperty('contextText');
  });
});
