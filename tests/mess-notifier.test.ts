import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessManager } from '../src/session/mess-manager.js';
import { MessPersistence } from '../src/session/mess-persistence.js';
import { MessNotifier } from '../src/session/mess-notifier.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProjectRecord } from '../src/types/project.js';

const project: ProjectRecord = {
  id: 'notifier-project',
  name: 'Notifier Project',
  canonicalPath: 'C:/notifier-project',
  createdAt: 1,
  updatedAt: 1,
  messPokeCooldownMinutes: 1,
};

const directories: string[] = [];

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(remindersAllowed: (sessionId: string) => boolean = () => true) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-mess-notifier-'));
  directories.push(directory);
  const projects = {
    getById: (id: string) => id === project.id ? project : undefined,
    findByPath: (path: string) => path === project.canonicalPath ? project : undefined,
    list: () => [project],
    save: () => {},
  };
  const sessions = new SessionManager(projects as any);
  const manager = new MessManager(sessions, projects as any, {
    now: () => Date.now(),
    persistenceFactory: projectId => new MessPersistence(projectId, { directory }),
  });
  const stateDetector = new EventEmitter();
  const deliveries: string[] = [];
  const sendSystemReminder = vi.fn(async (_sessionId: string, text: string) => {
    deliveries.push(text);
  });
  const notifier = new MessNotifier(
    manager,
    sessions,
    stateDetector as any,
    projects as any,
    { sendSystemReminder },
    () => true,
    remindersAllowed,
  );
  const sender = { id: 'sender', name: 'planner', cliType: 'test', processId: 1, workingDir: project.canonicalPath };
  const receiver = { id: 'receiver', name: 'memories', cliType: 'test', processId: 2, workingDir: project.canonicalPath, activityLevel: 'idle' as 'idle' | 'inactive' | 'active' };
  sessions.addSession(sender);
  sessions.addSession(receiver);
  return { manager, sessions, stateDetector, notifier, deliveries, sendSystemReminder, receiver };
}

describe('MessNotifier', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('pokes a session that is already idle when a post arrives', async () => {
    vi.useFakeTimers();
    const { manager, notifier, deliveries } = setup();
    manager.post('sender', 'hello');
    await flush();

    expect(deliveries).toEqual(['[HELM_MESS] 1 new — call mess_check']);
    notifier.dispose();
  });

  it('stays silent for a session whose CLI type has reminders turned off', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries } = setup(sessionId => sessionId !== 'receiver');
    manager.post('sender', 'hello');
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'idle' });
    await flush();

    expect(deliveries).toEqual([]);
    notifier.dispose();
  });

  it('does not poke the session that authored the post', async () => {
    vi.useFakeTimers();
    const { manager, sessions, notifier, deliveries } = setup();
    const sender = sessions.getSession('sender')!;
    sender.activityLevel = 'idle';
    manager.post('sender', 'my own post');
    await flush();

    expect(deliveries).toEqual(['[HELM_MESS] 1 new — call mess_check']);
    notifier.dispose();
  });

  it('pokes on an idle transition when unread mail already exists', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries } = setup();
    manager.post('sender', 'hello');
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'idle' });
    await flush();

    expect(deliveries).toHaveLength(1);
    notifier.dispose();
  });

  it('pokes again for every new post, even inside the cooldown', async () => {
    vi.useFakeTimers();
    const { manager, notifier, deliveries } = setup();
    manager.post('sender', 'one');
    await flush();
    manager.post('sender', 'two');
    await flush();

    expect(deliveries).toEqual([
      '[HELM_MESS] 1 new — call mess_check',
      '[HELM_MESS] 2 new — call mess_check',
    ]);
    notifier.dispose();
  });

  it('pokes only the addressed session for a targeted post', async () => {
    vi.useFakeTimers();
    const { manager, sessions, notifier, sendSystemReminder } = setup();
    sessions.addSession({
      id: 'bystander', name: 'bystander', cliType: 'test', processId: 3,
      workingDir: project.canonicalPath, activityLevel: 'idle',
    } as any);
    manager.post('sender', 'just for you', 'receiver');
    await flush();

    expect(sendSystemReminder.mock.calls.map(call => call[0])).toEqual(['receiver']);
    notifier.dispose();
  });

  // The poke itself is PTY output, which drops the session back to idle. Without
  // a cooldown on the idle path that would re-poke forever.
  it('still rate-limits idle transitions that carry no new post', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries } = setup();
    manager.post('sender', 'one');
    await flush();
    expect(deliveries).toHaveLength(1);

    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'idle' });
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'idle' });
    await flush();
    expect(deliveries).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await flush();
    expect(deliveries).toHaveLength(2);
    notifier.dispose();
  });

  it('does not retry after the mail is read or while the session is busy', async () => {
    vi.useFakeTimers();
    const first = setup();
    first.manager.post('sender', 'read me');
    await flush();
    first.manager.check('receiver');
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(first.deliveries).toHaveLength(1);
    first.notifier.dispose();

    const second = setup();
    second.manager.post('sender', 'busy');
    await flush();
    second.receiver.activityLevel = 'active';
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(second.deliveries).toHaveLength(1);
    second.notifier.dispose();
  });

  // Idle is 5 minutes of PTY silence. Waiting for it means a post lands on a
  // session that just printed anything up to 5 minutes late, or never while it
  // keeps working. Inactive (10s of silence) is receptive enough to poke.
  it('pokes a session that is merely inactive when a post arrives', async () => {
    vi.useFakeTimers();
    const { manager, notifier, deliveries, receiver } = setup();
    receiver.activityLevel = 'inactive';
    manager.post('sender', 'hello');
    await flush();

    expect(deliveries).toEqual(['[HELM_MESS] 1 new — call mess_check']);
    notifier.dispose();
  });

  it('catches up a session that was busy when the post arrived, on its next inactive transition', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    receiver.activityLevel = 'active';
    manager.post('sender', 'you were busy');
    await flush();
    expect(deliveries).toEqual([]);

    receiver.activityLevel = 'inactive';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();

    expect(deliveries).toEqual(['[HELM_MESS] 1 new — call mess_check']);
    notifier.dispose();
  });

  it('rate-limits catch-up so an inactive transition inside the cooldown is deferred', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    manager.post('sender', 'one');
    await flush();
    expect(deliveries).toHaveLength(1);

    receiver.activityLevel = 'inactive';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();
    expect(deliveries).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await flush();
    expect(deliveries).toHaveLength(2);
    notifier.dispose();
  });

  // A poke is itself PTY output: the session goes active, then inactive again.
  // The cooldown, not the activity level, is what stops that becoming a loop.
  it('does not re-poke on the inactive transition caused by its own poke', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    manager.post('sender', 'one');
    await flush();
    expect(deliveries).toHaveLength(1);

    receiver.activityLevel = 'active';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'active' });
    receiver.activityLevel = 'inactive';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();

    expect(deliveries).toHaveLength(1);
    notifier.dispose();
  });

  it('does not poke on an inactive transition when nothing is unread', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    manager.post('sender', 'read me');
    await flush();
    manager.check('receiver');

    receiver.activityLevel = 'inactive';
    vi.advanceTimersByTime(60_000);
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();

    expect(deliveries).toHaveLength(1);
    notifier.dispose();
  });

  it('pokes only the addressed session for a targeted post to an inactive target', async () => {
    vi.useFakeTimers();
    const { manager, sessions, notifier, sendSystemReminder, receiver } = setup();
    receiver.activityLevel = 'inactive';
    sessions.addSession({
      id: 'bystander', name: 'bystander', cliType: 'test', processId: 3,
      workingDir: project.canonicalPath, activityLevel: 'inactive',
    } as any);
    manager.post('sender', 'just for you', 'receiver');
    await flush();

    expect(sendSystemReminder.mock.calls.map(call => call[0])).toEqual(['receiver']);
    notifier.dispose();
  });

  // The cooldown exists to stop re-announcing mail the session has already been
  // told about. Mail that missed its receptive window was never announced, so
  // holding it for the full cooldown just delays a message nobody has seen.
  it('delivers mail that missed its receptive window without waiting out the cooldown', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    manager.post('sender', 'one');
    await flush();
    expect(deliveries).toHaveLength(1);

    receiver.activityLevel = 'active';
    manager.post('sender', 'two');
    await flush();
    expect(deliveries).toHaveLength(1);

    receiver.activityLevel = 'inactive';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();

    expect(deliveries).toEqual([
      '[HELM_MESS] 1 new — call mess_check',
      '[HELM_MESS] 2 new — call mess_check',
    ]);
    notifier.dispose();
  });

  // Unread returning to the same count is not evidence it is the same mail.
  it('delivers new mail that missed its window even when the unread count is unchanged', async () => {
    vi.useFakeTimers();
    const { manager, stateDetector, notifier, deliveries, receiver } = setup();
    manager.post('sender', 'one');
    await flush();
    manager.check('receiver');

    receiver.activityLevel = 'active';
    manager.post('sender', 'two');
    await flush();
    expect(deliveries).toHaveLength(1);

    receiver.activityLevel = 'inactive';
    stateDetector.emit('activity-change', { sessionId: 'receiver', level: 'inactive' });
    await flush();

    expect(deliveries).toHaveLength(2);
    notifier.dispose();
  });

  // A newcomer starts at the head, so no unread mail will ever tell it that the
  // project has been talking. One line on join is the only chance it gets.
  it('tells a joining session once that earlier mess exists', async () => {
    vi.useFakeTimers();
    const { manager, sessions, stateDetector, notifier, deliveries } = setup();
    manager.post('sender', 'earlier');
    await flush();
    deliveries.length = 0;

    sessions.addSession({
      id: 'newcomer', name: 'newcomer', cliType: 'test', processId: 4,
      workingDir: project.canonicalPath, activityLevel: 'idle',
    } as any);
    await flush();

    expect(deliveries).toEqual(['[HELM_MESS] joining — 1 earlier message, optional — call mess_check']);

    stateDetector.emit('activity-change', { sessionId: 'newcomer', level: 'inactive' });
    await flush();
    expect(deliveries).toHaveLength(1);
    notifier.dispose();
  });

  it('does not announce a join when the project has no earlier mess', async () => {
    vi.useFakeTimers();
    const { sessions, notifier, deliveries } = setup();
    sessions.addSession({
      id: 'newcomer', name: 'newcomer', cliType: 'test', processId: 4,
      workingDir: project.canonicalPath, activityLevel: 'idle',
    } as any);
    await flush();

    expect(deliveries).toEqual([]);
    notifier.dispose();
  });

  it('leaves a failed delivery retryable and clears timers on dispose', async () => {
    vi.useFakeTimers();
    const { manager, notifier, sendSystemReminder, deliveries } = setup();
    sendSystemReminder.mockRejectedValueOnce(new Error('pty exited'));
    manager.post('sender', 'retry me');
    await flush();
    expect(deliveries).toEqual([]);

    vi.advanceTimersByTime(60_000);
    await flush();
    expect(deliveries).toEqual(['[HELM_MESS] 1 new — call mess_check']);

    notifier.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
