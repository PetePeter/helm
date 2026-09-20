/**
 * LoopDriver — G8's Stop-block continuation and verification gates.
 *
 * Binding decisions under test (plan P-0789, decided context node
 * "Hook — loop driving: what decides go vs stop"):
 * - continuation NEVER decides for itself: it reads autoImplement (consent),
 *   the completed plan's followUpPlans (the what-next) and live plan state
 * - OFF by default — a session that has not opted in gets null, always
 * - cap (default 5): reached -> allow the stop and flash the user
 * - no measurable progress since the last Stop -> allow the stop
 * - the counter increments per auto-continue and resets on a user turn,
 *   but NOT on the UserPromptSubmit that carries our own block reason
 * - verification (completionRecap) is a QUALITY gate: one-shot, fires with
 *   loop driving OFF, never stacked on a continuation block, never counts
 *   toward the continuation cap
 * - StopFailure resets the loop and can never continue it
 *
 * Deps are plain fakes over real-shaped data — no mocks beyond winston.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  LoopDriver,
  type LoopDriverDeps,
  type LoopPlanView,
} from '../../../src/session/hooks/loop-driver';
import type { HookEvent } from '../../../src/session/hooks/hook-normaliser';
import type { SessionInfo } from '../../../src/types/session';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    name: 'worker',
    cliType: 'claude-code',
    processId: 42,
    workingDir: 'x:/repo',
    aiagentState: 'implementing',
    ...patch,
  };
}

function hookEvent(patch: Partial<HookEvent> = {}): HookEvent {
  return {
    cli: 'claude',
    event: 'PostToolUse',
    helmSessionId: 's1',
    toolName: 'Edit',
    receivedAt: 1,
    raw: {},
    ...patch,
  };
}

interface Harness {
  driver: LoopDriver;
  deps: LoopDriverDeps;
  emitter: EventEmitter;
  plans: Map<string, LoopPlanView>;
  sessions: Map<string, SessionInfo>;
  flashes: string[];
  updates: Array<[string, Partial<SessionInfo>]>;
  config: { enabled: boolean; maxAutoContinues: number };
  complete(patch?: Partial<Parameters<LoopDriver['noteCompletion']>[1]>): void;
}

function makeHarness(patch: Partial<SessionInfo> = {}, plans: LoopPlanView[] = []): Harness {
  const sessions = new Map<string, SessionInfo>([['s1', session(patch)]]);
  const planMap = new Map<string, LoopPlanView>(plans.map((p) => [p.id, p]));
  const flashes: string[] = [];
  const updates: Array<[string, Partial<SessionInfo>]> = [];
  const config = { enabled: true, maxAutoContinues: 5 };
  const deps: LoopDriverDeps = {
    getSession: (id) => sessions.get(id) ?? null,
    getPlan: (id) => planMap.get(id) ?? null,
    updateSession: (id, u) => updates.push([id, u]),
    flashAttention: (id) => flashes.push(id),
    getLoopConfig: () => config,
  };
  const driver = new LoopDriver(deps);
  const emitter = new EventEmitter();
  driver.watch(emitter);
  return {
    driver,
    deps,
    emitter,
    plans: planMap,
    sessions,
    flashes,
    updates,
    config,
    complete(override) {
      driver.noteCompletion('s1', {
        planId: 'p1',
        humanId: 'P-0001',
        title: 'First plan',
        followUps: [{ id: 'p2', humanId: 'P-0002', title: 'Follow up' }],
        ...override,
      });
    },
  };
}

describe('continuation — the three existing facts', () => {
  it('blocks naming the plan when the follow-up is auto-implement and ready', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    const block = h.driver.stopBlock(h.sessions.get('s1')!);
    expect(block).toBeTruthy();
    expect(block!).toContain('P-0002');
    expect(block!).toContain('Follow up');
    expect(block!).toContain('session_plan_claim');
  });

  it('allows the stop when the follow-up is not auto-implement', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'ready' },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('allows the stop when followUpPlans is empty — a natural terminator', () => {
    const h = makeHarness({ loopDriving: true });
    h.complete({ followUps: [] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('allows the stop when the follow-up still has incomplete precursors', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'planning', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('allows the stop when another session already claimed the follow-up', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'ready', autoImplement: true, sessionId: 'someone-else' },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('allows the stop when the follow-up was deleted between completion and Stop', () => {
    const h = makeHarness({ loopDriving: true });
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });
});

describe('continuation — hard stops', () => {
  it('is OFF by default: a session that has not opted in is never continued', () => {
    const h = makeHarness({}, [
      { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    expect(h.flashes).toEqual([]);
  });

  it('stops and flashes at the consecutive auto-continue cap, even with work outstanding', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
      { id: 'p3', humanId: 'P-0003', title: 'C', status: 'ready', autoImplement: true },
      { id: 'p4', humanId: 'P-0004', title: 'D', status: 'ready', autoImplement: true },
    ]);
    h.config.maxAutoContinues = 2;

    // Two full cycles: complete, Stop -> block. Each completion re-arms.
    h.complete({ followUps: [{ id: 'p2', humanId: 'P-0002', title: 'B' }] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x:/repo/a.ts' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [{ id: 'p3', humanId: 'P-0003', title: 'C' }] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0003');
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x:/repo/b.ts' } }));
    h.complete({ planId: 'p3', humanId: 'P-0003', title: 'C', followUps: [{ id: 'p4', humanId: 'P-0004', title: 'D' }] });

    // Cap (2) reached with D still outstanding: allow, flash once.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    expect(h.flashes).toEqual(['s1']);
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    expect(h.flashes).toEqual(['s1']); // flashed once, not per Stop
  });

  it('stops without a block when nothing measurable happened since the last Stop', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
      { id: 'p3', humanId: 'P-0003', title: 'C', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');

    // The agent claims nothing, edits nothing, completes nothing, stops again.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('treats an edit, a commit and a completion as progress', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');

    // A shell commit counts as progress even though no file-edit tool ran.
    h.emitter.emit('hook', hookEvent({ toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [] });
    // No follow-ups now — but the point is the Stop is decided, not spun.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('respects the global kill switch mid-loop', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [] });

    h.config.enabled = false;
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('respects the per-session kill switch mid-loop', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');
    h.sessions.set('s1', session({ loopDriving: false }));
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('NEVER continues a StopFailure — and resets the loop when the turn died', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    // The turn dies on an API error instead of stopping cleanly.
    h.emitter.emit('hook', hookEvent({ event: 'StopFailure' }));

    // Even with every continuation condition still true, nothing continues.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    expect(h.flashes).toEqual([]);
  });
});

describe('the visible counter', () => {
  it('increments per auto-continue and lands on the session row', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
      { id: 'p3', humanId: 'P-0003', title: 'C', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    h.driver.stopBlock(h.sessions.get('s1')!);
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [{ id: 'p3', humanId: 'P-0003', title: 'C' }] });
    h.driver.stopBlock(h.sessions.get('s1')!);

    const counterUpdates = h.updates.filter(([, u]) => 'loopContinues' in u);
    expect(counterUpdates.map(([, u]) => u.loopContinues)).toEqual([1, 2]);
  });

  it('resets on a genuine user turn, so a prodded loop starts counting fresh', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
      { id: 'p3', humanId: 'P-0003', title: 'C', status: 'ready', autoImplement: true },
    ]);
    h.config.maxAutoContinues = 1;
    h.complete();
    h.driver.stopBlock(h.sessions.get('s1')!); // continue 1/1
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [{ id: 'p3', humanId: 'P-0003', title: 'C' }] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull(); // cap

    // The user takes over: counter resets, the chain may continue again.
    h.emitter.emit('hook', hookEvent({ event: 'UserPromptSubmit', prompt: 'keep going please' }));
    const resets = h.updates.filter(([, u]) => u.loopContinues === undefined);
    expect(resets.length).toBeGreaterThan(0);
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0003');
  });

  it('does NOT reset when the UserPromptSubmit is our own block reason coming back', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
      { id: 'p3', humanId: 'P-0003', title: 'C', status: 'ready', autoImplement: true },
    ]);
    h.config.maxAutoContinues = 2;
    h.complete();
    const reason = h.driver.stopBlock(h.sessions.get('s1')!);
    expect(reason).toContain('P-0002');

    // The CLI feeds our reason back as the next prompt — that is the loop
    // itself, not the user. The counter must survive it.
    h.emitter.emit('hook', hookEvent({ event: 'UserPromptSubmit', prompt: reason! }));
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [{ id: 'p3', humanId: 'P-0003', title: 'C' }] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0003'); // continue 2/2
  });

  it('clears the row counter when a Stop is finally allowed', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    h.driver.stopBlock(h.sessions.get('s1')!);
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [] }); // chain ends

    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    const last = h.updates.filter(([, u]) => 'loopContinues' in u).at(-1);
    expect(last?.[1].loopContinues).toBeUndefined();
  });
});

describe('verification — completionRecap is a quality gate, never a continuation', () => {
  it('blocks ONCE when the last plan in a chain is marked for recap', () => {
    const h = makeHarness();
    h.complete({ completionRecap: true, followUps: [] });
    const first = h.driver.stopBlock(h.sessions.get('s1')!);
    expect(first).toBeTruthy();
    expect(first!).toMatch(/recap/i);
    // The second Stop ALWAYS passes, recap done or not.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('fires with loop driving OFF — verification is not part of the feature flag', () => {
    const h = makeHarness(); // no loopDriving opt-in
    h.complete({ completionRecap: true, followUps: [] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toMatch(/recap/i);
  });

  it('continuation wins when a valid auto-implement follow-up exists — one block, not two', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete({ completionRecap: true });
    const block = h.driver.stopBlock(h.sessions.get('s1')!);
    expect(block).toContain('P-0002');
    expect(block).not.toMatch(/recap/i);
  });

  it('a recap-flagged plan with a follow-up that is NOT eligible still verifies', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'planning', autoImplement: true },
    ]);
    h.complete({ completionRecap: true });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toMatch(/recap/i);
  });

  it('never fires for a completion that was not flagged', () => {
    const h = makeHarness();
    h.complete({ followUps: [] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('a new completion re-arms the one-shot recap ledger', () => {
    const h = makeHarness();
    h.complete({ completionRecap: true, followUps: [] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toMatch(/recap/i);
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', completionRecap: true, followUps: [] });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toMatch(/recap/i);
  });

  it('does not fire the recap when the cap ended the loop', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.config.maxAutoContinues = 1;
    h.complete({ completionRecap: true });
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002'); // 1/1, recap skipped for the completed plan
    h.emitter.emit('hook', hookEvent({ toolName: 'Edit', toolInput: { file_path: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', completionRecap: true, followUps: [] });
    // Cap exhausted and the chain is over: allow the stop, flash, no recap turn.
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
    expect(h.flashes).toEqual(['s1']);
  });
});

describe('session lifecycle', () => {
  it('ignores events for uncorrelated or unknown sessions', () => {
    const h = makeHarness({ loopDriving: true });
    h.emitter.emit('hook', hookEvent({ helmSessionId: null }));
    h.emitter.emit('hook', hookEvent({ helmSessionId: 'who' }));
    expect(() => h.driver.forgetSession('s1')).not.toThrow();
  });

  it('a forgotten session starts with a clean slate', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    h.driver.stopBlock(h.sessions.get('s1')!);
    h.driver.forgetSession('s1');
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });

  it('only edit-shaped tools and commits tick progress, reads do not', () => {
    const h = makeHarness({ loopDriving: true }, [
      { id: 'p2', humanId: 'P-0002', title: 'B', status: 'ready', autoImplement: true },
    ]);
    h.complete();
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toContain('P-0002');
    h.emitter.emit('hook', hookEvent({ toolName: 'Read', toolInput: { file_path: 'x' } }));
    h.emitter.emit('hook', hookEvent({ toolName: 'Grep', toolInput: { pattern: 'x' } }));
    h.complete({ planId: 'p2', humanId: 'P-0002', title: 'B', followUps: [] });
    // The completion itself is plan movement, so this Stop still decides —
    // the reads just did not contribute. (Covered by not spinning: fine.)
    expect(h.driver.stopBlock(h.sessions.get('s1')!)).toBeNull();
  });
});
