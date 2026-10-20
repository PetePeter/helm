/**
 * HookTracker tests — hook events become session truth.
 *
 * Real StateDetector / SessionManager / PlanManager /
 * ArtifactManager / ArtifactAttachmentManager / HandoverDelivery against the
 * temp APPDATA the vitest setup installs; the only fakes are the flash sink
 * (a recording object — the real NotificationManager drags Electron in) and
 * the hook receiver (a plain EventEmitter, which is what HookReceiver is).
 *
 * Sessions with NO hooks are covered by the existing state-detector suite:
 * the tracker only runs when a hook event arrives, so nothing here can change
 * the fallback path.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HookTracker, composePreCompactSnapshot } from '../../../src/session/hooks/hook-tracker.js';
import { normaliseHookEvent, type HookEvent } from '../../../src/session/hooks/hook-normaliser.js';
import { StateDetector, type ActivityChange } from '../../../src/session/state-detector.js';
import { SessionManager } from '../../../src/session/manager.js';
import { PlanManager } from '../../../src/session/plan-manager.js';
import { ArtifactManager } from '../../../src/session/artifact-manager.js';
import { ArtifactAttachmentManager, MAX_ATTACHMENT_BYTES } from '../../../src/session/artifact-attachment-manager.js';
import { HandoverDelivery } from '../../../src/session/handover-delivery.js';
import { SLOT_MS, TimeTracker, type TimeSlot } from '../../../src/session/time-tracker.js';
import type { SessionInfo } from '../../../src/types/session.js';

const NOW = 1_700_000_000_000;
const FLOOR_MS = 15_000;
const CEILING_MS = 300_000;

// PlanManager persists to the worker's shared temp APPDATA and RELOADS it on
// every construction — a previous test's still-active claimed item would win
// claimedPlanFor and poison the next test. Each setup therefore works in its
// own directory, and the claimed item is deleted on dispose.
let setupCounter = 0;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function hookEvent(
  cli: 'claude' | 'codex' | 'copilot',
  event: string,
  payload: Record<string, unknown> = {},
  sessionId = 's1',
): HookEvent {
  const normalised = normaliseHookEvent({ cli, event, payload }, () => NOW);
  if (!normalised) throw new Error(`fixture produced no event for ${cli}/${event}`);
  return { ...normalised, helmSessionId: sessionId };
}

interface Setup {
  tracker: HookTracker;
  hookReceiver: EventEmitter;
  stateDetector: StateDetector;
  activity: ActivityChange[];
  sessionManager: SessionManager;
  planManager: PlanManager;
  artifactManager: ArtifactManager;
  attachments: ArtifactAttachmentManager;
  handover: HandoverDelivery;
  flashes: string[];
  /** Per turn end: the session, and the transcript path the session held at that moment. */
  turnsEnded: Array<{ sessionId: string; transcript?: string }>;
  delivered: Array<{ sessionId: string; text: string }>;
  updates: Array<Partial<SessionInfo>>;
  timeTracker: TimeTracker;
  advanceTime: (ms: number) => void;
  addSession: (id?: string) => void;
  claimPlan: (sessionId: string, status?: 'ready' | 'coding') => string;
  dispose: () => void;
}

function setup(): Setup {
  const activity: ActivityChange[] = [];
  const flashes: string[] = [];
  const turnsEnded: Array<{ sessionId: string; transcript?: string }> = [];
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const losses: Array<{ sessionId: string; reason: string }> = [];
  const updates: Array<Partial<SessionInfo>> = [];

  const stateDetector = new StateDetector();
  stateDetector.on('activity-change', e => activity.push(e));

  const sessionManager = new SessionManager();
  sessionManager.on('session:updated', (e: SessionInfo) => updates.push(e));
  const persistedSlots: TimeSlot[] = [];
  let clock = NOW;
  const timeTracker = new TimeTracker({
    persistence: {
      append: slots => persistedSlots.push(...slots),
      load: (from, to) => persistedSlots.filter(slot => slot.start >= from && slot.start < to),
      saveBaselines: () => {},
      loadBaselines: () => null,
    },
    resolve: sessionId => sessionManager.hasSession(sessionId)
      ? { projectKey: 'p1', projectName: 'Project', dir: 'x:/repo' }
      : null,
    now: () => clock,
  });

  const planManager = new PlanManager();
  const artifactManager = new ArtifactManager();
  const attachmentDir = mkdtempSync(join(tmpdir(), 'helm-tracker-attachments-'));
  const attachments = new ArtifactAttachmentManager(attachmentDir);

  const handover = new HandoverDelivery(
    new EventEmitter(),
    sessionManager,
    async (sessionId, text) => { delivered.push({ sessionId, text }); },
    (sessionId, reason) => { losses.push({ sessionId, reason }); },
    { floorMs: FLOOR_MS, ceilingMs: CEILING_MS },
  );

  const tracker = new HookTracker({
    stateDetector,
    sessionManager,
    planManager,
    flashAttention: (sessionId: string) => { flashes.push(sessionId); },
    onTurnWorking: (sessionId) => timeTracker.armAi(sessionId),
    handoverDelivery: handover,
    artifactManager,
    artifactAttachments: attachments,
    onTurnEnded: (sessionId) => {
      timeTracker.disarmAi(sessionId);
      turnsEnded.push({ sessionId, transcript: sessionManager.getSession(sessionId)?.cliTranscriptPath });
    },
    now: () => NOW,
  });
  const hookReceiver = new EventEmitter();
  tracker.watch(hookReceiver);

  const addSession = (id = 's1'): void => {
    sessionManager.addSession({ id, name: `Session ${id}`, cliType: 'claude-code', processId: 1000 + activity.length, createdAt: NOW - 3_600_000 });
    activity.length = 0;
    updates.length = 0;
  };

  let claimedPlanId: string | null = null;
  const planDir = `x:/repo/tracker-${setupCounter++}`;
  const claimPlan = (sessionId: string, status: 'ready' | 'coding' = 'ready'): string => {
    const item = planManager.create(planDir, 'Ship the thing', 'do it well');
    planManager.setState(item.id, status === 'ready' ? 'ready' : 'coding');
    planManager.claimPlan(item.id, sessionId);
    claimedPlanId = item.id;
    return item.id;
  };

  const dispose = (): void => {
    tracker.dispose();
    handover.dispose();
    stateDetector.dispose();
    if (claimedPlanId) planManager.delete(claimedPlanId);
    rmSync(attachmentDir, { recursive: true, force: true });
  };

  return {
    tracker, hookReceiver, stateDetector, activity, sessionManager, planManager,
    artifactManager, attachments, handover, flashes, turnsEnded, delivered, updates,
    addSession, claimPlan, dispose, timeTracker,
    advanceTime: (ms: number) => { clock += ms; timeTracker.tick(); },
  };
}

describe('HookTracker — hook events become session truth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores an event with no correlated Helm session', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreToolUse', {}, null as unknown as string));
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop', {}, 'ghost-session'));
      expect(s.activity).toEqual([]);
      expect(s.flashes).toEqual([]);
    } finally {
      s.dispose();
    }
  });

  it('records the CLI thread id from a SessionStart session_id', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('codex', 'SessionStart', { session_id: 'thread-a' }));
      expect(s.sessionManager.getSession('s1')?.cliThreadId).toBe('thread-a');
    } finally {
      s.dispose();
    }
  });

  it('the newest thread id wins; an event without one keeps the stored id', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('codex', 'SessionStart', { session_id: 'thread-a' }));
      s.hookReceiver.emit('hook', hookEvent('codex', 'UserPromptSubmit', { session_id: 'thread-b' }));
      expect(s.sessionManager.getSession('s1')?.cliThreadId).toBe('thread-b');

      s.updates.length = 0;
      s.hookReceiver.emit('hook', hookEvent('codex', 'Stop', {}));
      s.hookReceiver.emit('hook', hookEvent('codex', 'Stop', { session_id: 'thread-b' }));
      expect(s.sessionManager.getSession('s1')?.cliThreadId).toBe('thread-b');
      // Unchanged id → no redundant session write.
      expect(s.updates.filter(u => 'cliThreadId' in u)).toEqual([]);
    } finally {
      s.dispose();
    }
  });

  it('records the newest transcript path so quick compact / CLI switch can read the log', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'SessionStart', { transcript_path: 'C:/t/a.jsonl' }));
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop', {}));
      expect(s.sessionManager.getSession('s1')?.cliTranscriptPath).toBe('C:/t/a.jsonl');
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { transcript_path: 'C:/t/b.jsonl' }));
      expect(s.sessionManager.getSession('s1')?.cliTranscriptPath).toBe('C:/t/b.jsonl');
    } finally {
      s.dispose();
    }
  });

  it('stamps lastPromptAt on every prompt — the session timer counts from it', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop', {}));
      expect(s.sessionManager.getSession('s1')?.lastPromptAt).toBeUndefined();
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'go' }));
      expect(s.sessionManager.getSession('s1')?.lastPromptAt).toBe(NOW);
    } finally {
      s.dispose();
    }
  });

  it.each(['SessionStart', 'PreCompact', 'PreToolUse', 'PostToolUse'] as const)(
    'restarts the cache timer on %s — the context was rebuilt',
    (event) => {
      const s = setup();
      try {
        s.addSession();
        s.sessionManager.updateSession('s1', { lastPromptAt: 5 });
        s.hookReceiver.emit('hook', hookEvent('claude', event, {}));
        expect(s.sessionManager.getSession('s1')?.lastPromptAt).toBe(NOW);
      } finally {
        s.dispose();
      }
    },
  );

  it('a Mess poke prompt restarts the cache timer — it mutates the context too', () => {
    const s = setup();
    try {
      s.addSession();
      s.sessionManager.updateSession('s1', { lastPromptAt: 5 });
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: '[HELM_MESS] 2 new — call mess_check' }));
      expect(s.sessionManager.getSession('s1')?.lastPromptAt).toBe(NOW);
    } finally {
      s.dispose();
    }
  });

  it('PreToolUse makes the dot green through the same activity-change contract as PTY output', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreToolUse', { tool_name: 'Bash' }));
      expect(s.activity).toEqual([
        { sessionId: 's1', level: 'active', lastOutputAt: expect.any(Number) },
      ]);
    } finally {
      s.dispose();
    }
  });

  it('Stop drops the dot out of green immediately and flashes the session once', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreToolUse'));
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop'));
      expect(s.activity[1]).toMatchObject({ sessionId: 's1', level: 'inactive' });
      expect(s.flashes).toEqual(['s1']);
    } finally {
      s.dispose();
    }
  });

  it('counts hook-reported work only through Stop', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreToolUse', { tool_name: 'Bash' }));
      s.advanceTime(6 * 60_000);
      expect(s.timeTracker.query(NOW - 24 * 60 * 60_000, NOW + 24 * 60 * 60_000).filter(slot => slot.kind === 'ai'))
        .toHaveLength(2);

      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop'));
      s.advanceTime(8 * 60 * 60_000);
      expect(s.timeTracker.query(NOW - 24 * 60 * 60_000, NOW + 24 * 60 * 60_000).filter(slot => slot.kind === 'ai'))
        .toHaveLength(2);
    } finally {
      s.dispose();
    }
  });

  it('counts a user-originated text-only turn from prompt through Stop', () => {
    const s = setup();
    try {
      s.addSession();
      s.timeTracker.recordPrompt('s1', 'user');
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit'));
      s.advanceTime(SLOT_MS);
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop'));
      s.advanceTime(SLOT_MS * 2);

      const aiStarts = s.timeTracker.query(0, Number.MAX_SAFE_INTEGER)
        .filter(slot => slot.kind === 'ai')
        .map(slot => slot.start);
      const firstSlot = NOW - (NOW % SLOT_MS);
      expect(aiStarts).toEqual([firstSlot, firstSlot + SLOT_MS]);
    } finally {
      s.dispose();
    }
  });

  it('a system UserPromptSubmit and later repaint do not become hook-reported work', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'watchdog check' }));
      s.stateDetector.processOutput('s1', 'a large TUI repaint after the system prompt');

      expect(s.timeTracker.query(NOW - 24 * 60 * 60_000, NOW + 24 * 60 * 60_000).filter(slot => slot.kind === 'ai'))
        .toEqual([]);
      expect(s.activity).toEqual([]);
    } finally {
      s.dispose();
    }
  });

  it('reports a turn end on Stop only, once the transcript path it carries is on the session', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'go' }));
      s.hookReceiver.emit('hook', hookEvent('claude', 'SubagentStop', {}));
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', { error: 'rate_limit' }));
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop', {}, 'ghost-session'));
      expect(s.turnsEnded).toEqual([]);

      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop', { transcript_path: 'C:/t/a.jsonl' }));
      expect(s.turnsEnded).toEqual([{ sessionId: 's1', transcript: 'C:/t/a.jsonl' }]);
    } finally {
      s.dispose();
    }
  });

  it('StopFailure reports the stall as fact and explicitly NOT as a normal completion', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', { error: 'API Error: usage limit reached' }));

      const session = s.sessionManager.getSession('s1')!;
      expect(session.hookStall).toEqual({ at: NOW, reason: 'API Error: usage limit reached' });
      expect(s.updates.some(u => 'hookStall' in u)).toBe(true);
      // Not a turn end: the dot must not pretend the agent finished.
      expect(s.activity).toEqual([]);
      expect(s.flashes).toEqual(['s1']);
    } finally {
      s.dispose();
    }
  });

  it('a repeated StopFailure with the same reason neither re-persists nor re-flashes', () => {
    const s = setup();
    try {
      s.addSession();
      const payload = { error: 'rate_limit' };
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', payload));
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', payload));

      expect(s.updates.filter(u => 'hookStall' in u)).toHaveLength(1);
      expect(s.flashes).toEqual(['s1']);
    } finally {
      s.dispose();
    }
  });

  it('work resuming after a stall clears it', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', { error: 'rate_limit' }));
      s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'continue' }));

      expect(s.sessionManager.getSession('s1')!.hookStall).toBeUndefined();
    } finally {
      s.dispose();
    }
  });

  it('PostToolUse on an edit moves a claimed ready plan to coding', () => {
    const s = setup();
    try {
      s.addSession();
      const planId = s.claimPlan('s1', 'ready');
      s.hookReceiver.emit('hook', hookEvent('claude', 'PostToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/x.ts' },
      }));
      expect(s.planManager.getItem(planId)!.status).toBe('coding');
    } finally {
      s.dispose();
    }
  });

  it('PostToolUse on a read-only tool leaves the claimed plan alone', () => {
    const s = setup();
    try {
      s.addSession();
      const planId = s.claimPlan('s1', 'ready');
      s.hookReceiver.emit('hook', hookEvent('claude', 'PostToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: 'src/x.ts' },
      }));
      expect(s.planManager.getItem(planId)!.status).toBe('ready');
    } finally {
      s.dispose();
    }
  });

  it('Stop with a claimed coding plan moves it to review', () => {
    const s = setup();
    try {
      s.addSession();
      const planId = s.claimPlan('s1', 'coding');
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop'));
      expect(s.planManager.getItem(planId)!.status).toBe('review');
    } finally {
      s.dispose();
    }
  });

  it('Stop leaves a ready (not yet worked) claimed plan in ready', () => {
    const s = setup();
    try {
      s.addSession();
      const planId = s.claimPlan('s1', 'ready');
      s.hookReceiver.emit('hook', hookEvent('claude', 'Stop'));
      expect(s.planManager.getItem(planId)!.status).toBe('ready');
    } finally {
      s.dispose();
    }
  });

  it('SessionStart clears a stale stall without claiming active work', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', { error: 'rate_limit' }));
      s.updates.length = 0;
      s.hookReceiver.emit('hook', hookEvent('claude', 'SessionStart', {}));

      expect(s.sessionManager.getSession('s1')!.hookStall).toBeUndefined();
      expect(s.activity).toEqual([]);
    } finally {
      s.dispose();
    }
  });
});

describe('HookTracker — PreCompact: Helm composes the snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function workingSession(s: Setup): void {
    s.addSession();
    s.claimPlan('s1', 'ready');
    s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'work' }));
    s.hookReceiver.emit('hook', hookEvent('claude', 'UserPromptSubmit', { prompt: 'more work' }));
    s.hookReceiver.emit('hook', hookEvent('claude', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }));
    s.hookReceiver.emit('hook', hookEvent('claude', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    s.handover.arm('s1', 'remember the handover note');
    s.updates.length = 0;
    s.activity.length = 0;
  }

  it('composes the snapshot artifact from Helm-held data and attaches the transcript', () => {
    const s = setup();
    try {
      workingSession(s);
      const transcript = join(tmpdir(), `helm-tracker-transcript-${Date.now()}.jsonl`);
      writeFileSync(transcript, '{"role":"user"}\n{"role":"assistant"}\n');

      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'auto', transcript_path: transcript }));

      const artifacts = s.artifactManager.getForSession('s1');
      expect(artifacts).toHaveLength(1);
      const snapshot = artifacts[0];
      expect(snapshot.title).toBe('Compaction snapshot');
      const body = snapshot.versions[0].content;
      expect(body).toContain('trigger: **auto**');
      expect(body).toContain('Ship the thing');
      // The claim advanced ready → coding when the edit landed, before PreCompact.
      expect(body).toContain('`coding`');
      expect(body).toContain('2 turn(s)');
      expect(body).toContain('Bash ×1');
      expect(body).toContain('Edit ×1');
      expect(body).toContain('src/x.ts');
      expect(body).toContain('remember the handover note');
      expect(body).toContain('transcript.jsonl');

      const attached = s.attachments.list(snapshot.id);
      expect(attached).toHaveLength(1);
      expect(attached[0].filename).toBe('transcript.jsonl');

      rmSync(transcript, { force: true });
    } finally {
      s.dispose();
    }
  });

  it('delivers the armed handover at PreCompact, and the later silence does not double it', async () => {
    const s = setup();
    try {
      workingSession(s);
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'manual' }));
      await flush();
      expect(s.delivered).toEqual([{ sessionId: 's1', text: 'remember the handover note' }]);
      expect(s.handover.isPending('s1')).toBe(false);

      // Post-compaction silence would deliver; nothing is left to deliver.
      vi.advanceTimersByTime(CEILING_MS + 1);
      await flush();
      expect(s.delivered).toHaveLength(1);
    } finally {
      s.dispose();
    }
  });

  it('falls back to the summary alone when no transcript is available', () => {
    const s = setup();
    try {
      workingSession(s);
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'auto' }));

      const snapshot = s.artifactManager.getForSession('s1')[0];
      expect(snapshot).toBeDefined();
      expect(s.attachments.list(snapshot.id)).toHaveLength(0);
      expect(snapshot.versions[0].content).toContain('No transcript was available to attach');
    } finally {
      s.dispose();
    }
  });

  it('keeps the summary alone when the transcript is over the attachment cap — no silent truncation', () => {
    const s = setup();
    try {
      workingSession(s);
      const huge = join(tmpdir(), `helm-tracker-huge-${Date.now()}.jsonl`);
      writeFileSync(huge, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'auto', transcript_path: huge }));

      const snapshot = s.artifactManager.getForSession('s1')[0];
      expect(s.attachments.list(snapshot.id)).toHaveLength(0);
      expect(snapshot.versions[0].content).toContain('No transcript was available to attach');
      rmSync(huge, { force: true });
    } finally {
      s.dispose();
    }
  });

  it('SessionStart resets the accumulated facts — the next snapshot starts at zero', () => {
    const s = setup();
    try {
      workingSession(s);
      s.hookReceiver.emit('hook', hookEvent('claude', 'SessionStart', {}));
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'auto' }));

      const body = s.artifactManager.getForSession('s1')[0].versions[0].content;
      expect(body).toContain('0 turn(s)');
      expect(body).not.toContain('Edit ×1');
    } finally {
      s.dispose();
    }
  });
});

describe('composePreCompactSnapshot — pure renderer of Helm-held state', () => {
  const base = {
    sessionName: 'opus low',
    trigger: 'auto' as const,
    turns: 12,
    ageMs: 3_700_000,
    plan: { title: 'Hook G3', status: 'coding' },
    toolCounts: [['Bash', 8], ['Edit', 3], ['Read', 1]] as Array<[string, number]>,
    filesTouched: ['src/b.ts', 'src/a.ts'],
    pendingHandover: 'the pre-written note',
    transcriptAttached: true,
  };

  it('renders every section from the facts', () => {
    const md = composePreCompactSnapshot(base);
    expect(md).toContain('# Compaction snapshot — opus low');
    expect(md).toContain('trigger: **auto**');
    expect(md).toContain('**Hook G3** — `coding`');
    expect(md).toContain('12 turn(s)');
    expect(md).toContain('Bash ×8');
    expect(md).toContain('Edit ×3');
    expect(md).toContain('`src/a.ts`, `src/b.ts`');
    expect(md).toContain('the pre-written note');
    expect(md).toContain('transcript.jsonl');
  });

  it('states its empties honestly instead of omitting them', () => {
    const md = composePreCompactSnapshot({
      sessionName: 'bare',
      trigger: undefined,
      turns: 0,
      plan: null,
      toolCounts: [],
      filesTouched: [],
      transcriptAttached: false,
    });
    expect(md).toContain('trigger: **unknown**');
    expect(md).toContain('none claimed');
    expect(md).toContain('0 turn(s)');
    expect(md).toContain('none recorded');
    expect(md).toContain('No pending handover note');
    expect(md).toContain('No transcript was available to attach');
  });
});
