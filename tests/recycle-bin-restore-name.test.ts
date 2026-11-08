// @vitest-environment jsdom

/**
 * Recycle-bin restore must bring the session back under the name it had when it
 * was closed — the bin entry carries `name`, and dropping it on the way back
 * leaves the session labelled after its cliType (pty:spawn's default).
 *
 * The restore IPC result and terminal manager are faked at their module
 * boundaries; the IPC clients are proxies over `window.helm`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

const mockRenameTerminal = vi.fn();

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  getTerminalManager: () => ({ renameSession: mockRenameTerminal }),
}));

function makeEntry(overrides: Partial<RecycleBinEntry> = {}): RecycleBinEntry {
  return {
    id: 'bin-1',
    sessionId: 'sess-1',
    name: 'My Session',
    cliType: 'claude-code',
    workingDir: 'X:/work',
    cliSessionName: 'uuid-abc',
    closedAt: 1700000000000,
    ...overrides,
  };
}

/** Records call order across the fakes so ordering assertions are possible. */
let callOrder: string[] = [];
let sessionRename: ReturnType<typeof vi.fn>;
let runtimeGroupReattach: ReturnType<typeof vi.fn>;
let recycleBinRestore: ReturnType<typeof vi.fn>;

function installWindow(entry: RecycleBinEntry | null): void {
  sessionRename = vi.fn(async () => { callOrder.push('rename'); return { success: true }; });
  runtimeGroupReattach = vi.fn(async () => { callOrder.push('reattach'); });
  recycleBinRestore = vi.fn(async () => { callOrder.push('restore'); return entry; });

  (globalThis as typeof globalThis & { window: any }).window = {
    helm: {
      recycleBin: {
        recycleBinList: vi.fn(async () => []),
        recycleBinRestore,
        recycleBinForget: vi.fn(async () => true),
        recycleBinEmpty: vi.fn(async () => true),
      },
      runtimeGroups: { runtimeGroupReattach },
      sessions: { sessionRename },
      events: { onRecycleBinChanged: vi.fn() },
    },
  };
}

async function loadRestore() {
  const mod = await import('../renderer/composables/useRecycleBin.js');
  return mod.useRecycleBin().restore;
}

describe('recycle-bin restore — atomic main-process operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    callOrder = [];
  });

  it('R1 delegates session metadata restoration to the single main-process call', async () => {
    installWindow(makeEntry());
    const restore = await loadRestore();

    await restore('bin-1');

    expect(recycleBinRestore).toHaveBeenCalledOnce();
    expect(sessionRename).not.toHaveBeenCalled();
    expect(mockRenameTerminal).not.toHaveBeenCalled();
  });

  it('R2 does not issue metadata IPC when the main-process restore fails', async () => {
    installWindow(null);
    const restore = await loadRestore();

    await restore('bin-1');

    expect(sessionRename).not.toHaveBeenCalled();
    expect(runtimeGroupReattach).not.toHaveBeenCalled();
  });

  it('R3 sends no separate rename or group reattach after atomic restore', async () => {
    installWindow(makeEntry({ runtimeGroupId: 'grp-1', runtimeGroupName: 'Group One' }));
    const restore = await loadRestore();

    await restore('bin-1');

    expect(recycleBinRestore).toHaveBeenCalledWith('bin-1');
    expect(sessionRename).not.toHaveBeenCalled();
    expect(runtimeGroupReattach).not.toHaveBeenCalled();
  });
});
