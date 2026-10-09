import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/session/initial-prompt.js', () => ({
  scheduleInitialPrompt: vi.fn(() => null),
}));

import { setupPtyHandlers } from '../src/electron/ipc/pty-handlers.js';

class MockPtyManager extends EventEmitter {
  write = vi.fn();
  setActivityMarker = vi.fn();
  setWriteGate = vi.fn();
  kill = vi.fn();
  resize = vi.fn();
  getTerminalTail = vi.fn(() => ({ raw: ['first line', 'second line'] }));
  on = vi.fn((event: string, listener: Function) => {
    super.on(event, listener);
    return this;
  });
}

class MockStateDetector extends EventEmitter {
  markActive = vi.fn();
  markScrolling = vi.fn();
  markResizing = vi.fn();
  markSwitching = vi.fn();
  processOutput = vi.fn();
  removeSession = vi.fn();
  on = vi.fn((event: string, listener: Function) => {
    super.on(event, listener);
    return this;
  });
}

function setup() {
  handlers.clear();
  const ptyManager = new MockPtyManager();
  const stateDetector = new MockStateDetector();
  const session = { id: 's1', interactionChannel: 'telegram' };
  const sessionManager = {
    getSession: vi.fn((id: string) => id === 's1' ? session : null),
    updateSession: vi.fn((_id: string, patch: object) => Object.assign(session, patch)),
    removeSession: vi.fn(),
  };
  const pipelineQueue = new EventEmitter();
  const windowManager = {
    getWindowForSession: vi.fn(() => null),
    getWindowIdForSession: vi.fn(() => undefined),
    isSessionOwnedByWebContents: vi.fn(() => true),
    markSessionRendererAttached: vi.fn(),
    markSessionRendererDetached: vi.fn(() => true),
  };
  const onPtyInput = vi.fn();

  setupPtyHandlers(
    ptyManager as any,
    stateDetector as any,
    sessionManager as any,
    pipelineQueue as any,
    windowManager as any,
    undefined,
    undefined,
    undefined,
    undefined,
    onPtyInput,
  );

  return { ptyManager, stateDetector, sessionManager, onPtyInput, windowManager };
}

describe('pty:write input origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Telegram affinity for programmatic writes', async () => {
    const { ptyManager, stateDetector, sessionManager, onPtyInput } = setup();

    await handlers.get('pty:write')?.({}, 's1', 'hello', { inputOrigin: 'programmatic' });

    expect(ptyManager.write).toHaveBeenCalledWith('s1', 'hello');
    // Activity marking moved into PtyManager.write, so it is not the handler's
    // job any more — proven against a real manager in pty-write-activity.test.ts.
    expect(stateDetector.markActive).not.toHaveBeenCalled();
    expect(sessionManager.updateSession).not.toHaveBeenCalledWith('s1', { interactionChannel: 'desktop' });
    expect(onPtyInput).not.toHaveBeenCalled();
  });

  it('returns PTY write failures to the renderer', async () => {
    const { ptyManager } = setup();
    ptyManager.write.mockImplementation(() => { throw new Error('broken pipe'); });

    const result = await handlers.get('pty:write')?.({}, 's1', 'register mcp');

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('broken pipe') });
  });

  it('reports a PTY manager write rejection instead of returning success', async () => {
    const { ptyManager } = setup();
    ptyManager.write.mockReturnValue(false);

    const result = await handlers.get('pty:write')?.({}, 's1', 'register mcp');

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('could not accept') });
  });

  it('switches Telegram affinity back to desktop for user writes', async () => {
    const { sessionManager, onPtyInput } = setup();

    await handlers.get('pty:write')?.({}, 's1', 'typed');

    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { interactionChannel: 'desktop' });
    expect(onPtyInput).toHaveBeenCalledWith('s1', 'typed');
  });

  it('Enter typed by the user restarts the session timer; plain typing and programmatic writes do not', async () => {
    const { sessionManager } = setup();
    const stamped = () => sessionManager.updateSession.mock.calls.filter(([, patch]) => 'lastPromptAt' in patch);

    await handlers.get('pty:write')?.({}, 's1', 'typing');
    await handlers.get('pty:write')?.({}, 's1', 'pasted\r', { inputOrigin: 'programmatic' });
    expect(stamped()).toHaveLength(0);

    await handlers.get('pty:write')?.({}, 's1', '\r');
    expect(stamped()).toHaveLength(1);
    expect(typeof stamped()[0][1].lastPromptAt).toBe('number');
    expect(stamped()[0][1]).toMatchObject({ lastUserPromptAt: expect.any(Number), lastUserPromptSource: 'terminal' });
  });

  it('rejects input from a renderer that does not own the session', async () => {
    const { ptyManager, windowManager } = setup();
    windowManager.isSessionOwnedByWebContents.mockReturnValue(false);

    await handlers.get('pty:write')?.({ sender: { id: 22 } }, 's1', 'stale renderer input');

    expect(ptyManager.write).not.toHaveBeenCalled();
  });

  it('returns main-process PTY replay only to the current renderer owner', async () => {
    const { ptyManager, windowManager } = setup();
    const attach = handlers.get('terminal:attach')!;

    expect(attach({ sender: { id: 7 } }, 's1')).toEqual({
      success: true,
      replay: 'first line\r\nsecond line',
    });

    windowManager.isSessionOwnedByWebContents.mockReturnValue(false);
    expect(attach({ sender: { id: 8 } }, 's1')).toEqual({
      success: false,
      error: 'Renderer does not own session',
    });
    expect(ptyManager.getTerminalTail).toHaveBeenCalledTimes(1);
  });
});
