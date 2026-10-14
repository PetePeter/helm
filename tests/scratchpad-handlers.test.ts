/**
 * Scratchpad IPC handlers: the pane's way into the real ScratchpadManager.
 * Only Electron's ipcMain is faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scratchpad } from '../src/types/scratchpad.js';

const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler); }) },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ScratchpadManager } = await import('../src/session/scratchpad-manager.js');
const { setupScratchpadHandlers } = await import('../src/electron/ipc/scratchpad-handlers.js');

describe('scratchpad IPC handlers', () => {
  let pads: InstanceType<typeof ScratchpadManager>;
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);

  beforeEach(() => {
    handlers.clear();
    const files = new Map<string, Scratchpad>();
    pads = new ScratchpadManager({
      load: id => files.get(id) ?? null,
      save: pad => { files.set(pad.sessionId, pad); },
      remove: id => { files.delete(id); },
      list: () => [...files.keys()],
    });
    setupScratchpadHandlers(pads, id => id === 'live' || id === 'binned');
  });

  it('writes as the user and reads the pad back', () => {
    expect(invoke('scratchpad:set', 'live', 'hello', 0)).toMatchObject({ ok: true, scratchpad: { revision: 1, updatedBy: 'user' } });
    expect(invoke('scratchpad:get', 'live')).toMatchObject({ text: 'hello', revision: 1 });
  });

  it('hands a stale write back to the pane instead of applying it', () => {
    pads.set('live', 'the AI was here', 'ai', 0);
    expect(invoke('scratchpad:set', 'live', 'user text', 0)).toMatchObject({
      ok: false, reason: 'stale', scratchpad: { text: 'the AI was here', revision: 1 },
    });
  });

  it('accepts the last keystrokes of a session that just went to the recycle bin', () => {
    expect(invoke('scratchpad:set', 'binned', 'typed as it closed', 0).ok).toBe(true);
  });

  it('refuses to create a pad for a session that no longer exists', () => {
    expect(() => invoke('scratchpad:set', 'gone', 'orphan', 0)).toThrow(/Session not found/);
    expect(pads.get('gone').revision).toBe(0);
  });

  it('rejects malformed arguments from the renderer', () => {
    expect(() => invoke('scratchpad:set', 'live', 42, 0)).toThrow(/text must be a string/);
    expect(() => invoke('scratchpad:set', 'live', 'x', '0')).toThrow(/baseRevision/);
    expect(() => invoke('scratchpad:get', '')).toThrow(/sessionId is required/);
  });
});
