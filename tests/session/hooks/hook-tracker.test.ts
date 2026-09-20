/**
 * HookTracker tests — hook events become session truth.
 *
 * Real StateDetector / SessionManager / PlanManager / DraftManager /
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
import { DraftManager } from '../../../src/session/draft-manager.js';
import { ArtifactManager } from '../../../src/session/artifact-manager.js';
import { ArtifactAttachmentManager, MAX_ATTACHMENT_BYTES } from '../../../src/session/artifact-attachment-manager.js';
import { HandoverDelivery } from '../../../src/session/handover-delivery.js';
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
  draftManager: DraftManager;
  artifactManager: ArtifactManager;
  attachments: ArtifactAttachmentManager;
  handover: HandoverDelivery;
  flashes: string[];
  delivered: Array<{ sessionId: string; text: string }>;
  updates: Array<Partial<SessionInfo>>;
  addSession: (id?: string) => void;
  claimPlan: (sessionId: string, status?: 'ready' | 'coding') => string;
  dispose: () => void;
}

function setup(): Setup {
  const activity: ActivityChange[] = [];
  const flashes: string[] = [];
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const losses: Array<{ sessionId: string; reason: string }> = [];
  const updates: Array<Partial<SessionInfo>> = [];

  const stateDetector = new StateDetector();
  stateDetector.on('activity-change', e => activity.push(e));

  const sessionManager = new SessionManager();
  sessionManager.on('session:updated', (e: SessionInfo) => updates.push(e));

  const planManager = new PlanManager();
  const draftManager = new DraftManager();
  const artifactManager = new ArtifactManager();
  const attachmentDir = mkdtempSync(join(tmpdir(), 'helm-tracker-attachments-'));
  const attachments = new ArtifactAttachmentManager(attachmentDir);

  // Same StateDetector instance — the double-delivery edge comes from the
  // real producer, not a re-creation of it.
  const handover = new HandoverDelivery(
    stateDetector,
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
    handoverDelivery: handover,
    draftManager,
    artifactManager,
    artifactAttachments: attachments,
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
    draftManager, artifactManager, attachments, handover, flashes, delivered, updates,
    addSession, claimPlan, dispose,
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

  it('SessionStart clears a stale stall and starts the dot green', () => {
    const s = setup();
    try {
      s.addSession();
      s.hookReceiver.emit('hook', hookEvent('claude', 'StopFailure', { error: 'rate_limit' }));
      s.updates.length = 0;
      s.hookReceiver.emit('hook', hookEvent('claude', 'SessionStart', {}));

      expect(s.sessionManager.getSession('s1')!.hookStall).toBeUndefined();
      expect(s.activity).toEqual([expect.objectContaining({ sessionId: 's1', level: 'active' })]);
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
    s.draftManager.create('s1', 'Next step', 'run the full suite');
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
      expect(body).toContain('**Next step** — run the full suite');
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

  it('delivers the armed handover at PreCompact, and the later lull edge does not double it', async () => {
    const s = setup();
    try {
      workingSession(s);
      s.hookReceiver.emit('hook', hookEvent('claude', 'PreCompact', { trigger: 'manual' }));
      await flush();
      expect(s.delivered).toEqual([{ sessionId: 's1', text: 'remember the handover note' }]);
      expect(s.handover.isPending('s1')).toBe(false);

      // Post-compaction silence: the fallback heuristic's edge. Nothing left.
      vi.advanceTimersByTime(10_000 + 1);
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
    drafts: [{ label: 'Follow-up', text: 'remember to rerun tests' }],
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
    expect(md).toContain('**Follow-up** — remember to rerun tests');
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
      drafts: [],
      transcriptAttached: false,
    });
    expect(md).toContain('trigger: **unknown**');
    expect(md).toContain('none claimed');
    expect(md).toContain('0 turn(s)');
    expect(md).toContain('none recorded');
    expect(md).toContain('No draft memo');
    expect(md).toContain('No pending handover note');
    expect(md).toContain('No transcript was available to attach');
  });
});
