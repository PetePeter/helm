/**
 * HelmSessionService tests — project-aware session filtering.
 */

import { describe, it, expect, vi } from 'vitest';
import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';

function makeSessionManager(sessions: Array<{ id: string; workingDir?: string; projectId?: string; projectPath?: string; name: string; cliType: string }>) {
  return {
    getAllSessions: vi.fn(() => sessions),
    getSession: vi.fn((id: string) => sessions.find((s) => s.id === id) ?? null),
  };
}

function makeConfigLoader() {
  return {
    getWorkingDirectories: vi.fn(() => []),
    getCliTypes: vi.fn(() => []),
    getCliTypeEntry: vi.fn(() => null),
    getCliTypeLabel: vi.fn((ref: string) => ref),
  };
}

function makePtyManager() {
  return {
    has: vi.fn(() => true),
    getTerminalTail: vi.fn(() => ({ raw: [], stripped: [] })),
  };
}

function makePlanManager() {
  return {
    getForDirectory: vi.fn(() => []),
  };
}

describe('HelmSessionService.listSessions', () => {
  it('returns all sessions when no filter is provided', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', workingDir: '/repo/main' },
      { id: 's2', name: 'B', cliType: 'claude-code', workingDir: '/repo/other' },
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const result = service.listSessions();
    expect(result).toHaveLength(2);
  });

  it('filters by dirPath matching workingDir', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', workingDir: '/repo/main' },
      { id: 's2', name: 'B', cliType: 'claude-code', workingDir: '/repo/other' },
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const result = service.listSessions('/repo/main');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1');
  });

  it('filters by dirPath matching projectPath', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', workingDir: '/repo/worktree-a', projectPath: '/repo/main' },
      { id: 's2', name: 'B', cliType: 'claude-code', workingDir: '/repo/other' },
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const result = service.listSessions('/repo/main');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1');
  });

  it('filters by projectId', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', workingDir: '/repo/main', projectId: 'proj-1', projectPath: '/repo/main' },
      { id: 's2', name: 'B', cliType: 'claude-code', workingDir: '/repo/worktree-a', projectId: 'proj-1', projectPath: '/repo/main' },
      { id: 's3', name: 'C', cliType: 'claude-code', workingDir: '/repo/other', projectId: 'proj-2', projectPath: '/repo/other' },
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const result = service.listSessions(undefined, 'proj-1');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['s1', 's2']);
  });
});

describe('HelmSessionService session times', () => {
  it('exposes createdAt/lastActiveAt as epoch ms + ISO on the summary', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', createdAt: 1700000000000, lastActiveAt: 1700000500000, activityLevel: 'inactive' } as any,
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const summary = service.getSession('s1')!;
    expect(summary.createdAtEpochMs).toBe(1700000000000);
    expect(summary.lastActiveAtEpochMs).toBe(1700000500000);
    expect(summary.createdAtIso).toBe(new Date(1700000000000).toISOString());
    expect(summary.lastActiveAtIso).toBe(new Date(1700000500000).toISOString());
  });

  it('reports lastActiveAt as "now" while the session is active (green)', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', createdAt: 1700000000000, lastActiveAt: 1700000500000, activityLevel: 'active' } as any,
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const before = Date.now();
    const summary = service.getSession('s1')!;
    expect(summary.lastActiveAtEpochMs).toBeGreaterThanOrEqual(before);
  });

  it('falls back to createdAt when lastActiveAt is missing', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', createdAt: 1700000000000 } as any,
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    const summary = service.getSession('s1')!;
    expect(summary.lastActiveAtEpochMs).toBe(1700000000000);
  });

  // The activity dot is the phone's only honest source for session state
  // (invariant 8). Without this field a mobile client can only read `state`,
  // which is pipeline state and would render the wrong thing.
  it('exposes activityLevel on the summary so a remote client can draw the dot', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', activityLevel: 'inactive' } as any,
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    expect(service.getSession('s1')!.activityLevel).toBe('inactive');
  });

  it('omits activityLevel when the session has never reported one', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code' } as any,
    ]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    expect(service.getSession('s1')!.activityLevel).toBeUndefined();
  });
});
