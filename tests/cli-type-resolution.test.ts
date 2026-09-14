/**
 * CLI type resolution — the single choke point every human/agent-supplied
 * cliType reference passes through (P-0659 phase 2).
 *
 * Real ConfigLoader over a real temp config dir; no mocking of the thing under
 * test. The point of these tests is the rename-survival guarantee: identity is
 * the UUID, so renaming a CLI type must never orphan a scheduled task, a
 * binding, or an MCP caller that only knows the old handle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ConfigLoader, AmbiguousCliTypeError } from '../src/config/loader.js';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { ScheduledTaskManager } from '../src/session/scheduled-task-manager.js';
import { saveScheduledTasks } from '../src/session/persistence.js';
import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';

/**
 * Scheduled-task persistence resolves to one process-wide config path, so this
 * file and src/session/scheduled-task-manager.test.ts — both driving a real
 * ScheduledTaskManager — clobber each other's task file when vitest runs them
 * in parallel workers. Keep this file's tasks in memory so the two are
 * independent (and so the suite never writes to the real user config dir).
 */
vi.mock('../src/session/persistence.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  let stored: unknown[] = [];
  return {
    ...actual,
    saveScheduledTasks: (tasks: unknown[]) => { stored = tasks; },
    loadScheduledTasks: () => stored,
  };
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let TEST_DIR: string;

/** Seed a pre-UUID cli-types.yaml; ConfigLoader.load() migrates it to uuid keys. */
function seedLegacyCliTypes(entries: Record<string, unknown>): void {
  fs.writeFileSync(path.join(TEST_DIR, 'cli-types.yaml'), YAML.stringify(entries), 'utf8');
}

function loadedLoader(): ConfigLoader {
  const loader = new ConfigLoader(TEST_DIR);
  loader.load();
  // Working dirs derive from projects; the MCP working-dir gate needs TEST_DIR
  // to belong to one before it will allow a spawn there.
  loader.setProjectStore({
    list: () => [{ id: 'p1', name: 'test', canonicalPath: TEST_DIR, alternatePaths: [] }],
  } as any);
  return loader;
}

/** The uuid key of the CLI type that was migrated from `slug`. */
function idForLegacy(loader: ConfigLoader, slug: string): string {
  const id = loader.getCliTypes().find((k) => loader.getCliTypeEntry(k)?.legacyKey === slug);
  if (!id) throw new Error(`no cli type migrated from ${slug}`);
  return id;
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(process.cwd(), '.test-cli-type-resolution-'));
  fs.writeFileSync(
    path.join(TEST_DIR, 'settings.yaml'),
    YAML.stringify({ hapticFeedback: true, notifications: true, escProtectionEnabled: true }),
    'utf8',
  );
  seedLegacyCliTypes({
    'claude-code': { name: 'Claude Code', spawnCommand: 'claude --session-id {cliSessionName}' },
    'copilot-cli': { name: 'Copilot CLI', spawnCommand: 'copilot' },
  });
});

afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// resolveCliType — the choke point itself
// ---------------------------------------------------------------------------

describe('ConfigLoader.resolveCliType', () => {
  it('resolves by uuid id', () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    expect(id).toMatch(UUID_V4);

    const resolved = loader.resolveCliType(id);
    expect(resolved?.id).toBe(id);
    expect(resolved?.config.displayName).toBe('Claude Code');
  });

  it('resolves by pre-migration legacy slug', () => {
    const loader = loadedLoader();
    const resolved = loader.resolveCliType('claude-code');
    expect(resolved?.id).toBe(idForLegacy(loader, 'claude-code'));
    expect(resolved?.config.displayName).toBe('Claude Code');
  });

  it('resolves by displayName case-insensitively and ignoring surrounding whitespace', () => {
    const loader = loadedLoader();
    const expected = idForLegacy(loader, 'copilot-cli');

    expect(loader.resolveCliType('Copilot CLI')?.id).toBe(expected);
    expect(loader.resolveCliType('copilot cli')?.id).toBe(expected);
    expect(loader.resolveCliType('COPILOT CLI')?.id).toBe(expected);
    expect(loader.resolveCliType('   Copilot CLI   ')?.id).toBe(expected);
  });

  it('prefers the uuid id over a displayName that collides with it', () => {
    const loader = loadedLoader();
    const claudeId = idForLegacy(loader, 'claude-code');
    // Rename Copilot so its label is literally Claude's uuid.
    loader.updateCliType(idForLegacy(loader, 'copilot-cli'), claudeId);

    expect(loader.resolveCliType(claudeId)?.config.displayName).toBe('Claude Code');
  });

  it('throws naming the conflicting ids when a displayName is ambiguous', () => {
    const loader = loadedLoader();
    const claudeId = idForLegacy(loader, 'claude-code');
    const copilotId = idForLegacy(loader, 'copilot-cli');
    loader.updateCliType(copilotId, 'Claude Code');

    let thrown: unknown;
    try { loader.resolveCliType('Claude Code'); } catch (err) { thrown = err; }

    expect(thrown).toBeInstanceOf(AmbiguousCliTypeError);
    const message = (thrown as Error).message;
    expect(message).toContain(claudeId);
    expect(message).toContain(copilotId);
    // Never silently picks one.
    expect(message).toContain('Ambiguous');
  });

  it('reports a clear miss for an unknown reference — no silent fallback', () => {
    const loader = loadedLoader();
    expect(loader.resolveCliType('not-a-cli')).toBeNull();
    expect(loader.resolveCliType('')).toBeNull();
    expect(loader.resolveCliType('   ')).toBeNull();
  });

  it('still resolves the legacy slug and the new label after a rename', () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    loader.updateCliType(id, 'Claude (work)');

    expect(loader.resolveCliType(id)?.id).toBe(id);
    expect(loader.resolveCliType('claude-code')?.id).toBe(id);
    expect(loader.resolveCliType('claude (work)')?.id).toBe(id);
    // The old label is gone — resolving it must miss, not fall back.
    expect(loader.resolveCliType('Claude Code')).toBeNull();
  });

  it('keeps bindings resolvable through every handle after a rename', () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    loader.setBinding('A', 'claude-code', { action: 'context-menu' });

    loader.updateCliType(id, 'Claude (work)');

    const expected = { A: { action: 'context-menu' } };
    expect(loader.getBindings(id)).toEqual(expected);
    expect(loader.getBindings('claude-code')).toEqual(expected);
    expect(loader.getBindings('Claude (work)')).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// configured-session-spawn
// ---------------------------------------------------------------------------

describe('spawnConfiguredSession — cliType resolution', () => {
  function harness() {
    const added: Array<Record<string, unknown>> = [];
    return {
      added,
      ptyManager: { spawn: vi.fn(() => ({ pid: 99 })), write: vi.fn() } as any,
      sessionManager: {
        addSession: vi.fn((info: Record<string, unknown>) => { added.push(info); }),
        updateSession: vi.fn(),
        hasSession: vi.fn(() => false),
      } as any,
    };
  }

  it('stores the canonical uuid and names the session after the displayName', () => {
    const loader = loadedLoader();
    const { added, ptyManager, sessionManager } = harness();

    spawnConfiguredSession({
      ptyManager, sessionManager, configLoader: loader,
      cliType: 'claude-code',
      cwd: TEST_DIR,
    });

    expect(added[0].cliType).toBe(idForLegacy(loader, 'claude-code'));
    expect(added[0].name).toBe('Claude Code');
  });

  it('does not fall back to `command: cliType` — an unresolvable cliType fails explicitly', () => {
    const loader = loadedLoader();
    const { ptyManager, sessionManager } = harness();

    expect(() => spawnConfiguredSession({
      ptyManager, sessionManager, configLoader: loader,
      cliType: 'no-such-cli',
      cwd: TEST_DIR,
    })).toThrow(/no-such-cli/);

    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('never passes a uuid through as the executable name', () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    // A type with no command templates at all — the old code would have run the uuid.
    loader.updateCliType(id, 'Claude Code', undefined, undefined, { spawnCommand: '' });
    const { ptyManager, sessionManager } = harness();

    expect(() => spawnConfiguredSession({
      ptyManager, sessionManager, configLoader: loader,
      cliType: id,
      cwd: TEST_DIR,
    })).toThrow(/no spawnCommand/);

    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MCP session_create
// ---------------------------------------------------------------------------

describe('MCP session_create — cliType resolution', () => {
  function makeService(loader: ConfigLoader, added: Array<Record<string, unknown>>) {
    const sessionManager = {
      getAllSessions: vi.fn(() => []),
      getSession: vi.fn(() => null),
      hasSession: vi.fn(() => false),
      addSession: vi.fn((info: Record<string, unknown>) => { added.push(info); }),
      updateSession: vi.fn(),
    };
    const ptyManager = { spawn: vi.fn(() => ({ pid: 7 })), write: vi.fn(), has: vi.fn(() => true) };
    return new HelmSessionService(
      sessionManager as any,
      ptyManager as any,
      loader as any,
      { getForDirectory: vi.fn(() => []) } as any,
    );
  }

  it('resolves a displayName and a uuid to the same CLI type', () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    const added: Array<Record<string, unknown>> = [];
    const service = makeService(loader, added);

    service.spawnCli('Claude Code', TEST_DIR, 'by name');
    service.spawnCli(id, TEST_DIR, 'by uuid');

    expect(added).toHaveLength(2);
    expect(added[0].cliType).toBe(id);
    expect(added[1].cliType).toBe(id);
  });

  it('rejects an unknown cliType', () => {
    const loader = loadedLoader();
    const service = makeService(loader, []);
    expect(() => service.spawnCli('nope', TEST_DIR, 'x')).toThrow(/Unknown CLI type/);
  });

  it('names the session after the CLI when session_create sends no name', () => {
    const loader = loadedLoader();
    const added: Array<Record<string, unknown>> = [];
    const service = makeService(loader, added);

    const created = service.spawnCli('Claude Code', TEST_DIR, undefined);

    // The same default the desktop's own spawn uses (the UI passes no
    // sessionName either): the resolved CLI's displayName, never a placeholder.
    expect(created.id).toBeTruthy();
    expect(added[0].name).toBe('Claude Code');
  });
});

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

describe('ScheduledTaskManager — cliType resolution', () => {
  class FakeSessionManager {
    added: Array<Record<string, unknown>> = [];
    addSession(info: Record<string, unknown>) { this.added.push(info); }
    getSession(id: string) { return this.added.find((s) => s.id === id); }
    getActiveSession() { return null; }
    setActiveSession() {}
    removeSession() {}
  }

  class FakePtyManager extends EventEmitter {
    spawned: Array<Record<string, unknown>> = [];
    spawn(options: Record<string, unknown>) { this.spawned.push(options); return { pid: 4242 }; }
    has() { return true; }
    write() {}
    deliverText() {}
    async nudgeResize() {}
  }

  let manager: ScheduledTaskManager | undefined;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    manager?.stop();
    manager = undefined;
    saveScheduledTasks([]);
  });

  it('spawns the right CLI for a task stored under the pre-rename handle', async () => {
    const loader = loadedLoader();
    const id = idForLegacy(loader, 'claude-code');
    const sessionManager = new FakeSessionManager();
    const ptyManager = new FakePtyManager();
    manager = new ScheduledTaskManager(
      sessionManager as any, ptyManager as any,
      { getItem: () => undefined } as any, loader as any,
    );

    // Task was created before the rename, so it still names the old slug.
    manager.createTask({
      title: 'Nightly',
      planIds: [],
      initialPrompt: 'go',
      cliType: 'claude-code',
      scheduledTime: new Date(Date.now() - 1000),
      dirPath: TEST_DIR,
    });
    loader.updateCliType(id, 'Claude (renamed)');

    manager.start();
    await vi.runOnlyPendingTimersAsync();

    expect(ptyManager.spawned).toHaveLength(1);
    expect(ptyManager.spawned[0].rawCommand).toContain('claude --session-id');
    expect(sessionManager.added[0].cliType).toBe(id);
  });

  it('rejects an unknown CLI type at create time rather than executing a uuid', async () => {
    const loader = loadedLoader();
    const sessionManager = new FakeSessionManager();
    const ptyManager = new FakePtyManager();
    manager = new ScheduledTaskManager(
      sessionManager as any, ptyManager as any,
      { getItem: () => undefined } as any, loader as any,
    );

    expect(() => manager!.createTask({
      title: 'Broken',
      planIds: [],
      initialPrompt: 'go',
      cliType: 'deleted-cli',
      scheduledTime: new Date(Date.now() - 1000),
      dirPath: TEST_DIR,
    })).toThrow(/Unknown CLI type/);

    manager.start();
    await vi.runOnlyPendingTimersAsync();

    expect(manager.listTasks()).toHaveLength(0);
    expect(ptyManager.spawned).toHaveLength(0);
  });
});
