import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, sourceWindow, otherWindow } = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  sourceWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  otherWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  },
  dialog: {},
  BrowserWindow: {
    fromWebContents: vi.fn(() => sourceWindow),
    getAllWindows: vi.fn(() => [sourceWindow, otherWindow]),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setupConfigHandlers } = await import('../src/electron/ipc/config-handlers.js');

function handler(channel: string): Function {
  const found = handlers.get(channel);
  if (!found) throw new Error(`Missing IPC handler ${channel}`);
  return found;
}

describe('filter preference IPC', () => {
  let saved: Record<string, unknown>;
  const loader = {
    getFilterPreference: (id: string) => saved[id],
    setFilterPreference: (id: string, value: unknown) => { saved[id] = value; },
  } as any;

  beforeEach(() => {
    handlers.clear();
    saved = {};
    sourceWindow.webContents.send.mockClear();
    otherWindow.webContents.send.mockClear();
    setupConfigHandlers(loader);
  });

  it('writes values by ID and broadcasts changes to other windows', async () => {
    const result = await handler('config:setFilterPreference')({ sender: {} }, 'todo.done', 'no');

    expect(result).toEqual({ success: true });
    expect(saved['todo.done']).toBe('no');
    expect(sourceWindow.webContents.send).not.toHaveBeenCalled();
    expect(otherWindow.webContents.send).toHaveBeenCalledWith('config:filterPreferenceChanged', {
      id: 'todo.done', value: 'no',
    });
    expect(handler('config:getFilterPreference')({}, 'todo.done')).toBe('no');
  });
});
