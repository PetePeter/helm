/**
 * Draft IPC handlers: the pane's way into the real DraftManager.
 * Only Electron's ipcMain is faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../src/types/draft.js';

const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler); }) },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DraftManager } = await import('../src/session/draft-manager.js');
const { setupDraftHandlers } = await import('../src/electron/ipc/draft-handlers.js');

describe('draft IPC handlers', () => {
  let pads: InstanceType<typeof DraftManager>;
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);

  beforeEach(() => {
    handlers.clear();
    const files = new Map<string, Draft>();
    pads = new DraftManager({
      load: id => files.get(id) ?? null,
      save: pad => { files.set(pad.sessionId, pad); },
      remove: id => { files.delete(id); },
      list: () => [...files.keys()],
    });
    setupDraftHandlers(pads, id => id === 'live' || id === 'binned');
  });

  it('writes as the user and reads the pad back', () => {
    expect(invoke('draft:set', 'live', 'hello', 0)).toMatchObject({ ok: true, draft: { revision: 1, updatedBy: 'user' } });
    expect(invoke('draft:get', 'live')).toMatchObject({ text: 'hello', revision: 1 });
  });

  it('hands a stale write back to the pane instead of applying it', () => {
    pads.set('live', 'the AI was here', 'ai', 0);
    expect(invoke('draft:set', 'live', 'user text', 0)).toMatchObject({
      ok: false, reason: 'stale', draft: { text: 'the AI was here', revision: 1 },
    });
  });

  it('accepts the last keystrokes of a session that just went to the recycle bin', () => {
    expect(invoke('draft:set', 'binned', 'typed as it closed', 0).ok).toBe(true);
  });

  it('refuses to create a pad for a session that no longer exists', () => {
    expect(() => invoke('draft:set', 'gone', 'orphan', 0)).toThrow(/Session not found/);
    expect(pads.get('gone').revision).toBe(0);
  });

  it('rejects malformed arguments from the renderer', () => {
    expect(() => invoke('draft:set', 'live', 42, 0)).toThrow(/text must be a string/);
    expect(() => invoke('draft:set', 'live', 'x', '0')).toThrow(/baseRevision/);
    expect(() => invoke('draft:get', '')).toThrow(/sessionId is required/);
  });
});
