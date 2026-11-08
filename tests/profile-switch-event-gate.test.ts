/**
 * After a profile switch the previous profile's sessions keep running, but the
 * renderer now shows another profile. Every main→renderer push of
 * session-scoped data must be gated on ProfileRuntimeRegistry
 * .isSessionInActiveProfile. Real registry, real gate classes; only Electron
 * windows are fakes.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ProfileRuntimeRegistry } from '../src/session/profile-runtime-registry.js';
import type { ProfileRuntime } from '../src/session/profile-runtime.js';
import { NotificationManager } from '../src/session/notification-manager.js';
import { MessageFlightGate } from '../src/electron/ipc/message-flight-gate.js';
import { setupAdminVoiceSurface } from '../src/electron/ipc/voice-handlers.js';
import type { ChatBridge } from '../src/session/chat/chat-bridge.js';
import { createChatEntryForwarder } from '../src/electron/ipc/chat-handlers.js';
import type { SessionMessageFlight } from '../src/session/message-flight.js';
import type { ChatJournalEntry } from '../src/mobile/mobile-chat-journal.js';
import type { WindowManager } from '../src/electron/window-manager.js';
import type { SessionManager } from '../src/session/manager.js';

const electronState = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => electronState.windows },
  Notification: class { on = vi.fn(); show = vi.fn(); },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function runtime(id: string, sessionIds: string[]): ProfileRuntime {
  return {
    userProfileId: id,
    sessionManager: { hasSession: (s: string) => sessionIds.includes(s), getSession: (s: string) => (sessionIds.includes(s) ? { id: s } : undefined) },
  } as unknown as ProfileRuntime;
}

let activeProfile = '1';
let registry: ProfileRuntimeRegistry;

beforeEach(() => {
  activeProfile = '1';
  registry = new ProfileRuntimeRegistry([runtime('1', ['s1']), runtime('2', ['s2'])], () => activeProfile);
});

function fakeWindow() {
  return { isDestroyed: () => false, isFocused: () => true, isVisible: () => true, flashFrame: vi.fn(), webContents: { send: vi.fn() } };
}

describe('registry gate', () => {
  it('is true only for the active profile\'s sessions and false for unknown sessions', () => {
    expect(registry.isSessionInActiveProfile('s1')).toBe(true);
    expect(registry.isSessionInActiveProfile('s2')).toBe(false);
    expect(registry.isSessionInActiveProfile('nope')).toBe(false);
    activeProfile = '2';
    expect(registry.isSessionInActiveProfile('s2')).toBe(true);
    expect(registry.isSessionInActiveProfile('s1')).toBe(false);
  });
});

describe('chat:entry forwarding', () => {
  const entry = (sessionId: string) => ({ seq: 1, record: { sessionId, sessionName: 'n', text: 'secret' } }) as unknown as ChatJournalEntry;

  it('forwards the active profile\'s entry and drops an inactive profile\'s after a switch', () => {
    const win = fakeWindow();
    const forward = createChatEntryForwarder({
      isSessionVisible: s => registry.isSessionInActiveProfile(s),
      getWindows: () => [win],
    });
    forward(entry('s1'));
    expect(win.webContents.send).toHaveBeenCalledWith('chat:entry', expect.objectContaining({ seq: 1 }));
    win.webContents.send.mockClear();

    activeProfile = '2';
    forward(entry('s1'));
    expect(win.webContents.send).not.toHaveBeenCalled();
    forward(entry('s2'));
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });
});

describe('notify_user / flash desktop delivery', () => {
  function manager(win: ReturnType<typeof fakeWindow>) {
    electronState.windows = [win];
    return new NotificationManager({} as WindowManager, {} as SessionManager, registry);
  }

  it('shows the active profile\'s notification', () => {
    const win = fakeWindow();
    expect(manager(win).notifyLlmDirected('s1', 'T', 'body')).toBe('bubble');
    expect(win.webContents.send).toHaveBeenCalledWith('notification:llmNotify', { sessionId: 's1', title: 'T', content: 'body' });
  });

  it('sends nothing (no bubble, no toast path) for an inactive profile after a switch', () => {
    const win = fakeWindow();
    const notifications = manager(win);
    activeProfile = '2';
    expect(notifications.notifyLlmDirected('s1', 'T', 'private body')).toBe('none');
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(notifications.flashAttention('s1')).toEqual({ flashed: true });
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(notifications.flashAttention('s2')).toEqual({ flashed: true });
  });

  it('still alerts the owning phone for an inactive profile (desktop-only gate)', () => {
    const win = fakeWindow();
    const notifications = manager(win);
    const mobile = { notified: vi.fn(), flashed: vi.fn() };
    notifications.setMobileNotifier(mobile);
    activeProfile = '2';
    notifications.notifyLlmDirected('s1', 'T', 'body');
    notifications.flashAttention('s1');
    expect(mobile.notified).toHaveBeenCalledWith('s1', 'T', 'body');
    expect(mobile.flashed).toHaveBeenCalledWith('s1');
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('message flights', () => {
  const flight = (recipientSessionId: string): SessionMessageFlight => ({
    flightId: `f-${recipientSessionId}`, senderSessionId: 'x', senderSessionName: 'Sender',
    recipientSessionId, recipientName: 'Recipient', expectsResponse: false, isReply: false,
  });
  let broadcast: Mock<(flight: SessionMessageFlight) => void>;
  let observe: Mock<(flight: SessionMessageFlight) => void>;
  let gate: MessageFlightGate;

  beforeEach(() => {
    broadcast = vi.fn<(flight: SessionMessageFlight) => void>();
    observe = vi.fn<(flight: SessionMessageFlight) => void>();
    gate = new MessageFlightGate({ isSessionVisible: s => registry.isSessionInActiveProfile(s), broadcast, observe });
  });

  it('holds an active-profile flight until it is acked', async () => {
    let released = false;
    const sent = gate.send(flight('s1')).then(() => { released = true; });
    expect(broadcast).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(released).toBe(false);
    gate.ack('f-s1');
    await sent;
    expect(released).toBe(true);
  });

  it('does not broadcast an inactive profile\'s flight, releases it at once, still observes it', async () => {
    activeProfile = '2';
    await gate.send(flight('s1'));
    expect(broadcast).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
  });

  it('rejects an ack once the flight\'s profile is no longer active', async () => {
    let released = false;
    const sent = gate.send(flight('s1')).then(() => { released = true; });
    activeProfile = '2';
    gate.ack('f-s1');
    await Promise.resolve();
    expect(released).toBe(false);
    activeProfile = '1';
    gate.ack('f-s1');
    await sent;
    expect(released).toBe(true);
  });
});

describe('admin operator voice reply', () => {
  function surface() {
    let bridge: ChatBridge | undefined;
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const adminGuard = {
      isAdmin: (id: string) => id === '1',
      requireAdmin: (id: string = activeProfile) => { if (id !== '1') throw new Error('Admin only'); },
    };
    setupAdminVoiceSurface({
      adminRuntime: { userProfileId: '1', configLoader: {} } as unknown as ProfileRuntime,
      adminGuard,
      ptyManager: {} as never,
      operatorSessionManager: { getOperatorId: () => 'op' } as never,
      chatBroker: { register: (b: ChatBridge) => { bridge = b; } } as never,
      mobileChatBridge: {} as never,
      mobileChatJournal: {} as never,
      windowManager: { getMainWindow: () => win } as unknown as WindowManager,
      tempDir: '.',
    });
    return { bridge: bridge!, win };
  }
  const reply = { sessionId: 'op', text: 'admin only words', source: 'agent', originId: 'o' } as never;

  it('reaches the main window while the admin profile is active', async () => {
    const { bridge, win } = surface();
    await bridge.sendToSession(reply);
    expect(win.webContents.send).toHaveBeenCalledWith('voice:operatorReply', { sessionId: 'op', text: 'admin only words' });
  });

  it('is not sent to the renderer after switching to a non-admin profile', async () => {
    const { bridge, win } = surface();
    activeProfile = '2';
    await bridge.sendToSession(reply);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
