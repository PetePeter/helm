import type { MobileChatJournal } from '../mobile/mobile-chat-journal.js';
import type { ProfileRuntime } from '../session/profile-runtime.js';
import { RecycleBinPurgeQueue, type ScheduleImmediate } from '../session/recycle-bin-purge-queue.js';
import type { RecycleBinPurgeJob } from '../types/recycle-bin.js';
import { logger } from '../utils/logger.js';

interface ManagedProfile {
  runtime: ProfileRuntime;
  queue: RecycleBinPurgeQueue;
  onChanged: () => void;
}

/** Owns one fixed-store purge queue for every registered profile runtime. */
export class RecycleBinPurgeMaintenance {
  private readonly profiles = new Map<string, ManagedProfile>();
  private started = false;

  constructor(private readonly options: {
    chatJournal?: Pick<MobileChatJournal, 'pruneSession'>;
    scheduleImmediate?: ScheduleImmediate;
  } = {}) {}

  add(runtime: ProfileRuntime): void {
    if (this.profiles.has(runtime.userProfileId)) return;
    const queue = new RecycleBinPurgeQueue(
      runtime.recycleBinManager,
      job => this.purge(runtime, job),
      this.options.scheduleImmediate,
    );
    const onChanged = () => queue.wake();
    runtime.recycleBinManager.on('recycle-bin:changed', onChanged);
    this.profiles.set(runtime.userProfileId, { runtime, queue, onChanged });
    if (this.started) this.startProfile(runtime, queue);
  }

  remove(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    profile.runtime.recycleBinManager.off('recycle-bin:changed', profile.onChanged);
    profile.queue.dispose();
    this.profiles.delete(profileId);
  }

  /** Called once after the first main window is visible. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const { runtime, queue } of this.profiles.values()) this.startProfile(runtime, queue);
  }

  dispose(): void {
    for (const profileId of [...this.profiles.keys()]) this.remove(profileId);
  }

  private startProfile(runtime: ProfileRuntime, queue: RecycleBinPurgeQueue): void {
    try {
      runtime.recycleBinManager.pruneExpired();
    } catch (error) {
      logger.error(`[recycleBin] Failed to queue expired entries for profile ${runtime.userProfileId}: ${error}`);
    }
    queue.start();
  }

  private purge(runtime: ProfileRuntime, job: RecycleBinPurgeJob): void {
    const { sessionId } = job.entry;
    runtime.memoryManager.purgeSession(sessionId);
    runtime.messManager.onSessionClosed(sessionId, job.kind);
    this.options.chatJournal?.pruneSession(sessionId, true);
    runtime.artifactManager.clearSession(sessionId, true);
    runtime.draftManager.clearSession(sessionId, true);
    runtime.todoManager.clearSession(sessionId, true);

    const tempPaths = runtime.artifactTempRegistry.pathsFor(sessionId);
    runtime.artifactTempRegistry.drain(sessionId);
    const remaining = runtime.artifactTempRegistry.pathsFor(sessionId).length;
    if (remaining > 0) throw new Error(`Could not delete ${remaining}/${tempPaths.length} temp copies`);
  }
}
