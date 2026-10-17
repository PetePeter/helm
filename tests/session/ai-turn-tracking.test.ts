import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryLock } from '../../src/session/delivery-lock.js';
import { buildKeepWarmPrompt } from '../../src/session/keep-warm-prompt.js';
import { HookTracker } from '../../src/session/hooks/hook-tracker.js';
import { normaliseHookEvent } from '../../src/session/hooks/hook-normaliser.js';
import { PtyManager, type PtyProcess } from '../../src/session/pty-manager.js';
import { deliverPromptSequenceToSession, setDeliveryObserver } from '../../src/session/sequence-delivery.js';
import { SessionManager } from '../../src/session/manager.js';
import { StateDetector } from '../../src/session/state-detector.js';
import { TimePersistence } from '../../src/session/time-persistence.js';
import { TimeTracker } from '../../src/session/time-tracker.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BASE = new Date(2026, 9, 17).getTime();
const HOUR = 60 * 60_000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-turn-tracking-'));
  let clock = BASE;
  const detector = new StateDetector();
  const activity: Array<{ sessionId: string; level: string }> = [];

  const tracker = new TimeTracker({
    persistence: new TimePersistence(dir),
    resolve: id => id === 's1' ? { projectKey: 'p1', projectName: 'Project', dir: 'C:/work' } : null,
    now: () => clock,
  });
  detector.on('activity-change', event => {
    activity.push(event);
    if (event.level === 'idle' && !detector.hasObservedHooks(event.sessionId)) tracker.disarmAi(event.sessionId);
  });

  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const ptyManager = new PtyManager();
  const process: PtyProcess = {
    pid: 1,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => undefined,
    onExit: callback => { onExit = callback; },
  };
  ptyManager.adopt('s1', process, { cols: 120, rows: 30 });
  ptyManager.setActivityMarker(sessionId => detector.markActive(sessionId));

  const sessionManager = new SessionManager();
  sessionManager.addSession({ id: 's1', name: 'worker', cliType: 'claude-code', processId: 1, workingDir: 'C:/work' });
  const hookTracker = new HookTracker({
    stateDetector: detector,
    sessionManager,
    planManager: { claimedItemFor: () => null, claimedPlanFor: () => null } as never,
    flashAttention: () => undefined,
    handoverDelivery: { deliverFromPreCompact: () => undefined, peek: () => undefined } as never,
    artifactManager: { create: () => undefined } as never,
    artifactAttachments: { add: () => undefined } as never,
    onTurnWorking: sessionId => tracker.armAi(sessionId),
    onTurnEnded: sessionId => tracker.disarmAi(sessionId),
    now: () => clock,
  });
  const hookReceiver = new EventEmitter();
  hookTracker.watch(hookReceiver);
  const configLoader = { getCliTypeEntry: () => ({ submitSuffix: '\r' }) } as never;

  const emitHook = (event: string): void => {
    const normalized = normaliseHookEvent({ cli: 'claude', event, payload: {} }, () => clock);
    if (!normalized) throw new Error(`Could not normalize Claude ${event} hook`);
    hookReceiver.emit('hook', { ...normalized, helmSessionId: 's1' });
  };

  setDeliveryObserver((sessionId, origin) => tracker.recordPrompt(sessionId, origin));

  const deliver = async (text: string, origin?: 'user' | 'system'): Promise<void> => {
    const pending = deliverPromptSequenceToSession({
      sessionId: 's1', text, ptyManager, sessionManager, configLoader,
      ...(origin ? { origin } : {}),
      deliveryLock: new DeliveryLock(),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  };

  return {
    activity,
    detector,
    deliver,
    emitHook,
    advance: async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
      tracker.tick();
    },
    dispose: () => {
      setDeliveryObserver(null);
      hookTracker.dispose();
      detector.dispose();
      onExit?.({ exitCode: 0 });
      fs.rmSync(dir, { recursive: true, force: true });
    },
    setClock: (value: number) => { clock = value; },
    tracker,
  };
}

describe('AI turn tracking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts user prompts but not system or keep-warm prompts', async () => {
    const s = setup();
    try {
      await s.deliver('watchdog check');
      await s.deliver(buildKeepWarmPrompt());
      expect(s.tracker.query(BASE, BASE + 24 * HOUR)).toEqual([]);

      await s.deliver('please do this', 'user');
      expect(s.tracker.query(BASE, BASE + 24 * HOUR).map(slot => slot.kind).sort()).toEqual(['ai', 'user']);
    } finally {
      s.dispose();
    }
  });

  it('counts a hookless user prompt until fallback idle, then stops', async () => {
    const s = setup();
    try {
      await s.deliver('please do this', 'user');
      await s.advance(6 * 60_000);
      await s.advance(10 * 60_000);

      const aiStarts = s.tracker.query(BASE, BASE + 24 * HOUR)
        .filter(slot => slot.kind === 'ai')
        .map(slot => slot.start);
      expect(aiStarts).toEqual([BASE]);
    } finally {
      s.dispose();
    }
  });

  it('keeps a system prompt and hours of TUI repaint from creating AI time or a green dot', async () => {
    const s = setup();
    try {
      await s.deliver('scheduled watchdog check');
      s.emitHook('UserPromptSubmit');
      s.emitHook('Stop');
      expect(s.activity.at(-1)?.level).toBe('inactive');

      for (let hour = 1; hour <= 8; hour++) {
        const now = BASE + hour * HOUR;
        s.setClock(now);
        await vi.advanceTimersByTimeAsync(HOUR);
        s.detector.processOutput('s1', 'a full-screen TUI repaint that exceeds the activity threshold');
        s.tracker.tick();
      }

      expect(s.tracker.query(BASE, BASE + 24 * HOUR)).toEqual([]);
      expect(s.activity.some(event => event.level === 'active')).toBe(false);
    } finally {
      s.dispose();
    }
  });
});
