import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { setupChatHandlers } from '../src/electron/ipc/chat-handlers.js';

function registeredHandler(channel: string): (...args: any[]) => Promise<any> | any {
  const registration = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!registration) throw new Error(`No handler registered for ${channel}`);
  return registration[1] as (...args: any[]) => Promise<any> | any;
}

describe('desktop Chat IPC', () => {
  beforeEach(() => vi.mocked(ipcMain.handle).mockClear());

  it('loads journal history for any session id', () => {
    const workerHistory = [{ seq: 3, record: { sessionId: 'worker', sessionName: 'Worker', text: 'reply', at: 123 } }];
    const history = vi.fn((sessionId: string) => sessionId === 'worker' ? workerHistory : []);
    setupChatHandlers({
      history,
      deliver: vi.fn(),
      fanOut: vi.fn(),
    });

    expect(registeredHandler('chat:history')({}, 'worker')).toBe(workerHistory);
    expect(history).toHaveBeenCalledWith('worker');
    expect(registeredHandler('chat:history')({}, '')).toEqual([]);
  });

  it('mirrors a desktop turn only after session delivery succeeds', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('session PTY is not running'));
    const fanOut = vi.fn();
    setupChatHandlers({ history: () => [], deliver, fanOut });

    const result = await registeredHandler('chat:send')({}, { sessionId: 'worker', text: 'hello' });

    expect(result).toEqual({ ok: false, error: 'session PTY is not running' });
    expect(fanOut).not.toHaveBeenCalled();
  });

  it('fans out one desktop-origin turn after successful delivery', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const fanOut = vi.fn().mockResolvedValue([]);
    setupChatHandlers({ history: () => [], deliver, fanOut });

    const result = await registeredHandler('chat:send')({}, {
      sessionId: 'worker', text: 'hello', filePath: 'C:\\tmp\\note.txt',
    });

    expect(result).toEqual({ ok: true });
    expect(deliver).toHaveBeenCalledWith({ sessionId: 'worker', text: 'hello', filePath: 'C:\\tmp\\note.txt' });
    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'worker',
      text: 'hello',
      filePath: 'C:\\tmp\\note.txt',
      source: 'desktop',
      originId: expect.stringMatching(/^desktop:/),
    }));
  });
});
