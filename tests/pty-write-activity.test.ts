/**
 * Activity marking on PTY writes.
 *
 * Only user-input intent marks activity. Main-process system prompts still
 * reach the PTY, but do not fabricate user activity or turn the dot green.
 *
 * Real PtyManager, real StateDetector, fake PTY. The IPC boundary objects
 * (session/window managers) stay as thin stubs — they are not what is under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { StateDetector } from '../src/session/state-detector.js';
import { setupPtyHandlers } from '../src/electron/ipc/pty-handlers.js';

function createRecordingPty(): { pty: PtyProcess; writes: string[] } {
  const writes: string[] = [];
  const pty: PtyProcess = {
    pid: 99,
    write: (data: string) => { writes.push(data); },
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  };
  return { pty, writes };
}

function createManager(): { manager: PtyManager; writes: string[] } {
  const { pty, writes } = createRecordingPty();
  const factory: PtyFactory = { spawn: () => pty };
  const manager = new PtyManager(factory);
  // Empty command so the spawn writes nothing of its own.
  manager.spawn({ sessionId: 's1', command: '' });
  return { manager, writes };
}

describe('PtyManager.write — activity marking', () => {
  it('marks the session active for a plain write', () => {
    const { manager } = createManager();
    const marked: string[] = [];
    manager.setActivityMarker(id => marked.push(id));

    manager.write('s1', 'hello');

    expect(marked).toEqual(['s1']);
  });

  it('marks a main-process delivery only when it carries user-input intent', async () => {
    const { manager, writes } = createManager();
    const marked: string[] = [];
    manager.setActivityMarker(id => marked.push(id));

    await manager.deliverText('s1', 'hello', { writeIntent: 'input' });

    expect(writes).toEqual(['hello']);
    expect(marked).toEqual(['s1']);
  });

  it('does not mark when the PTY does not exist', () => {
    const { manager } = createManager();
    const marked: string[] = [];
    manager.setActivityMarker(id => marked.push(id));

    manager.write('missing', 'hello');

    expect(marked).toEqual([]);
  });

  it('does not mark for scroll writes — a scrollback redraw is not new work', () => {
    const { manager, writes } = createManager();
    const marked: string[] = [];
    manager.setActivityMarker(id => marked.push(id));

    manager.write('s1', '\x1b[A', 'scroll');

    expect(writes).toEqual(['\x1b[A']);
    expect(marked).toEqual([]);
  });
});

describe('pty IPC handlers — activity marking after the move', () => {
  function setup() {
    handlers.clear();
    const { pty } = createRecordingPty();
    const factory: PtyFactory = { spawn: () => pty };
    const ptyManager = new PtyManager(factory);
    ptyManager.spawn({ sessionId: 's1', command: '' });

    const stateDetector = new StateDetector();
    const markActive = vi.spyOn(stateDetector, 'markActive');
    const markScrolling = vi.spyOn(stateDetector, 'markScrolling');

    const session = { id: 's1', interactionChannel: 'telegram' };
    const sessionManager = {
      getSession: vi.fn((id: string) => (id === 's1' ? session : null)),
      updateSession: vi.fn(),
      removeSession: vi.fn(),
      hasSession: vi.fn(() => true),
    };
    const windowManager = {
      getWindowForSession: vi.fn(() => null),
      getWindowIdForSession: vi.fn(() => undefined),
    };
    const onPtyInput = vi.fn();

    setupPtyHandlers(
      ptyManager,
      stateDetector,
      sessionManager as any,
      new EventEmitter() as any,
      windowManager as any,
      undefined,
      undefined,
      undefined,
      undefined,
      onPtyInput,
    );

    return { ptyManager, stateDetector, markActive, markScrolling, sessionManager, onPtyInput };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks exactly once for a pty:write — the handler no longer marks on its own', async () => {
    const { markActive } = setup();

    await handlers.get('pty:write')?.({}, 's1', 'hello');

    expect(markActive).toHaveBeenCalledTimes(1);
    expect(markActive).toHaveBeenCalledWith('s1');
  });

  it('marks a write issued straight at the manager, bypassing IPC entirely', async () => {
    const { ptyManager, markActive } = setup();

    ptyManager.write('s1', 'from main');

    expect(markActive).toHaveBeenCalledWith('s1');
  });

  it('keeps scroll input off the activity dots', async () => {
    const { markActive, markScrolling } = setup();

    await handlers.get('pty:scrollInput')?.({}, 's1', '\x1b[A');

    expect(markActive).not.toHaveBeenCalled();
    expect(markScrolling).toHaveBeenCalledWith('s1');
  });
});
