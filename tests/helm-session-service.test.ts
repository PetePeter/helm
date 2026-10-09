/**
 * HelmSessionService tests — project-aware session filtering.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';
import { SessionManager } from '../src/session/manager.js';

let contextDir: string;

beforeEach(() => {
  contextDir = mkdtempSync(join(tmpdir(), 'helm-session-context-'));
});

afterEach(() => {
  rmSync(contextDir, { recursive: true, force: true });
});

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
  it('carries freeze and prompt-cache staleness for the phone', () => {
    const sessionManager = makeSessionManager([
      { id: 's1', name: 'A', cliType: 'claude-code', workingDir: '/r', frozen: true, lastPromptAt: 1000 } as any,
      { id: 's2', name: 'B', cliType: 'claude-code', workingDir: '/r' },
    ]);
    const config = makeConfigLoader();
    config.getCliTypeEntry.mockReturnValue({ cacheWarnMinutes: 3 } as any);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, config as any, makePlanManager() as any);

    const [frozen, fresh] = service.listSessions();
    expect(frozen).toMatchObject({ frozen: true, lastPromptAtEpochMs: 1000, cacheWarnMinutes: 3, cacheExpireMinutes: 60 });
    expect(fresh.frozen).toBeUndefined();
    expect(fresh.lastPromptAtEpochMs).toBeUndefined();
  });

  it('flags a CLI type with no prompt cache, so the phone shows no staleness', () => {
    const sessionManager = makeSessionManager([{ id: 's1', name: 'A', cliType: 'local', workingDir: '/r', lastPromptAt: 1000 } as any]);
    const config = makeConfigLoader();
    config.getCliTypeEntry.mockReturnValue({ noPromptCache: true } as any);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, config as any, makePlanManager() as any);
    expect(service.listSessions()[0]).toMatchObject({ noPromptCache: true });
  });

  it('includes ComfyUI model and size choices in the session summary', () => {
    const sessionManager = makeSessionManager([{
      id: 's1', name: 'Comfy image', cliType: 'comfy', comfyUiTool: true,
      comfyUiProfiles: [{ id: 'flux', name: 'FLUX', kind: 'image', supportsImageSize: true, maxReferenceImages: 1 }],
      comfyUiImageSizes: [{ id: 'qhd-portrait', name: 'QHD Portrait', width: 1440, height: 2560 }],
    } as any]);
    const service = new HelmSessionService(sessionManager as any, makePtyManager() as any, makeConfigLoader() as any, makePlanManager() as any);

    expect(service.getSession('s1')).toMatchObject({
      comfyUiTool: true,
      comfyUiProfiles: [{ id: 'flux', name: 'FLUX', kind: 'image', supportsImageSize: true, maxReferenceImages: 1 }],
      comfyUiImageSizes: [{ id: 'qhd-portrait', name: 'QHD Portrait', width: 1440, height: 2560 }],
    });
  });

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

describe('HelmSessionService context size', () => {
  it('adds context to session_get while keeping the session_list row light', () => {
    const cliTranscriptPath = join(contextDir, 'transcript.jsonl');
    writeFileSync(cliTranscriptPath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-10T09:30:00Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 100_000, output_tokens: 0 } },
    }));
    const sessionManager = new SessionManager();
    sessionManager.addSession({
      id: 'context-session', name: 'Context session', cliType: 'claude', cliTranscriptPath,
    } as any, true);
    const config = {
      getCliTypeEntry: () => ({ contextWindow: 200_000 }),
      getCliTypeLabel: (cliType: string) => cliType,
    };
    const service = new HelmSessionService(
      sessionManager,
      makePtyManager() as any,
      config as any,
      makePlanManager() as any,
    );

    expect(service.getSession('context-session')?.context).toEqual({
      known: true,
      tokens: 100_000,
      window: 200_000,
      percent: 50,
      measuredAtIso: '2026-10-10T09:30:00.000Z',
      source: 'transcript',
    });
    expect(service.listSessions()[0]).not.toHaveProperty('context');
  });

  it('uses the API host’s server-reported token count for an API session', () => {
    const sessionManager = new SessionManager();
    sessionManager.addSession({
      id: 'api-context-session', name: 'API context session', cliType: 'api', apiTool: true,
    } as any, true);
    const config = {
      getCliTypeEntry: () => ({ contextWindow: 10_000 }),
      getCliTypeLabel: (cliType: string) => cliType,
    };
    const service = new HelmSessionService(
      sessionManager,
      makePtyManager() as any,
      config as any,
      makePlanManager() as any,
    );
    service.setApiContextSizeLookup(() => ({ available: true, tokens: 2_500 }));

    expect(service.getSession('api-context-session')?.context).toEqual({
      known: true,
      tokens: 2_500,
      window: 10_000,
      percent: 25,
      source: 'api',
    });
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
