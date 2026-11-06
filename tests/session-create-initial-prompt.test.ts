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

describe('HelmSessionService.spawnCli — initialPrompt sender envelope', () => {
  beforeEach(() => { spawnCalls.length = 0; });

  function makeServiceWithSessions(sessions: Record<string, { id: string; name: string }>) {
    const configLoader = {
      getWorkingDirectories: vi.fn(() => [{ path: '/repo/main', name: 'main' }]),
      getCliTypes: vi.fn(() => []),
      resolveCliType: vi.fn((ref: string) => ({ id: ref, config: { name: 'Claude Code', spawnCommand: 'claude' } })),
    };
    const sessionManager = {
      getSession: vi.fn((id: string) => sessions[id] ?? null),
      updateSession: vi.fn(),
    };
    return new HelmSessionService(sessionManager as any, {} as any, configLoader as any, {} as any);
  }

  function envelopeOf(text: string): Record<string, unknown> {
    const match = /^\[HELM_MSG\](\{.*?\})/.exec(text);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
  }

  it('tags a session creator as the sender, like session_send_text', () => {
    makeServiceWithSessions({ 'creator-sid': { id: 'creator-sid', name: 'Orchestrator' } })
      .spawnCli('claude-code', '/repo/main', 'worker', { creatorSessionId: 'creator-sid', initialPrompt: 'Build it' });

    const text = spawnCalls[0].contextText as string;
    expect(envelopeOf(text)).toMatchObject({
      type: 'inter_llm_message', fromSessionId: 'creator-sid', fromSessionName: 'Orchestrator', expectsResponse: false,
    });
    expect(text.endsWith('Build it')).toBe(true);
  });

  it('tags a phone creator by its proxy identity', () => {
    makeServiceWithSessions({})
      .spawnCli('claude-code', '/repo/main', 'worker', { creatorSessionId: 'mobile:dev-1', initialPrompt: 'Read plan P-0001' });

    expect(envelopeOf(spawnCalls[0].contextText as string)).toMatchObject({
      fromSessionId: 'mobile:dev-1', fromSessionName: 'mobile:dev-1',
    });
  });
});
