import { describe, expect, it, vi } from 'vitest';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { HelmRecycleBinService } from '../src/mcp/services/helm-recycle-bin-service.js';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

function makeEntry(overrides: Partial<RecycleBinEntry> = {}): RecycleBinEntry {
  return {
    id: 'entry-alpha',
    sessionId: 'session-alpha',
    name: 'Alpha API',
    cliType: 'claude-code',
    workingDir: 'X:/repo',
    cliSessionName: 'private-cli-session',
    cliThreadId: 'private-thread-id',
    closedAt: 2_000,
    projectId: 'project-1',
    projectName: 'Gamepad',
    runtimeGroupId: 'group-1',
    runtimeGroupName: 'Tablet',
    mission: { text: 'Release alpha', setBy: 'operator', setAt: 1_000 },
    ...overrides,
  };
}

function makeService(entries: RecycleBinEntry[], restore = vi.fn(async () => entries[0] ?? null)) {
  return new HelmRecycleBinService(
    {
      list: () => entries,
      peek: id => entries.find(entry => entry.id === id) ?? null,
    },
    'profile-1',
    restore,
  );
}

describe('HelmRecycleBinService', () => {
  it('searches case-insensitively across name, directory, project, and mission text', () => {
    const entry = makeEntry();
    const service = makeService([entry]);

    expect(service.search({ query: 'ALPHA' })).toHaveLength(1);
    expect(service.search({ query: 'repo' })).toHaveLength(1);
    expect(service.search({ query: 'GAMEPAD' })).toHaveLength(1);
    expect(service.search({ query: 'release' })).toHaveLength(1);
  });

  it('filters by exact directory and CLI and orders newest first', () => {
    const old = makeEntry({ id: 'old', closedAt: 1_000 });
    const newest = makeEntry({ id: 'newest', closedAt: 3_000 });
    const otherDirectory = makeEntry({ id: 'other-dir', workingDir: 'X:/elsewhere', closedAt: 4_000 });
    const service = makeService([old, otherDirectory, newest]);

    expect(service.search({ dirPath: 'X:/repo', cliType: 'claude-code' }).map(entry => entry.id))
      .toEqual(['newest', 'old']);
    expect(service.search({ limit: 1 }).map(entry => entry.id)).toEqual(['other-dir']);
  });

  it('defaults to 20 results', () => {
    const entries = Array.from({ length: 22 }, (_, index) => makeEntry({
      id: `entry-${index}`,
      closedAt: index,
    }));
    const service = makeService(entries);

    expect(service.search()).toHaveLength(20);
    expect(service.search()[0].closedAt).toBe(21);
  });

  it('projects safe search results without CLI resume credentials', () => {
    const service = makeService([makeEntry()]);

    expect(service.search()).toEqual([{
      id: 'entry-alpha',
      name: 'Alpha API',
      cliType: 'claude-code',
      dir: 'X:/repo',
      project: { id: 'project-1', name: 'Gamepad' },
      runtimeGroup: { id: 'group-1', name: 'Tablet' },
      closedAt: 2_000,
      mission: 'Release alpha',
    }]);
  });

  it('restores by id and uses name only as an expected-name guard', async () => {
    const entry = makeEntry();
    const restore = vi.fn(async () => entry);
    const service = makeService([entry], restore);

    await expect(service.restore({ id: entry.id, name: entry.name })).resolves.toEqual({ sessionId: entry.sessionId });
    expect(restore).toHaveBeenCalledWith(entry.id, { profileId: 'profile-1', expectedName: entry.name });
  });

  it('rejects unknown/expired entries and mismatched expected names before restoring', async () => {
    const entry = makeEntry();
    const restore = vi.fn(async () => entry);
    const service = makeService([entry], restore);

    await expect(service.restore({ id: 'missing' })).rejects.toThrow(/not found or expired/i);
    await expect(service.restore({ id: entry.id, name: 'Different name' })).rejects.toThrow(/expected name/i);
    expect(restore).not.toHaveBeenCalled();
  });
});

describe('recycle-bin MCP dispatch', () => {
  it('routes both tools through the profile control service', async () => {
    const service = {
      searchRecycleBin: vi.fn(() => [{ id: 'entry-1' }]),
      restoreRecycleBin: vi.fn(async () => ({ sessionId: 'session-1' })),
    };
    const deps = {
      service,
      setPlanStateWithValidation: vi.fn(),
      completePlanWithValidation: vi.fn(),
    } as any;

    await expect(callMcpTool(deps, 'recycle_bin_search', { query: 'alpha' }, {}))
      .resolves.toEqual([{ id: 'entry-1' }]);
    await expect(callMcpTool(deps, 'recycle_bin_restore', { id: 'entry-1', name: 'Saved name' }, {}))
      .resolves.toEqual({ sessionId: 'session-1' });
    expect(service.searchRecycleBin).toHaveBeenCalledWith({ query: 'alpha' });
    expect(service.restoreRecycleBin).toHaveBeenCalledWith({ id: 'entry-1', name: 'Saved name' });
  });
});
