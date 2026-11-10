import { logger } from '../utils/logger.js';
import type { RecycleBinPurgeJob } from '../types/recycle-bin.js';

interface RecycleBinPurgeStore {
  pendingPurgeJobs(skipIds?: ReadonlySet<string>): RecycleBinPurgeJob[];
  completePurge(entryId: string): void;
}

export type ScheduleImmediate = (callback: () => void) => unknown;

/** Drains durable recycle-bin cleanup intent without processing two sessions in one turn. */
export class RecycleBinPurgeQueue {
  private readonly attempted = new Set<string>();
  private started = false;
  private scheduled = false;
  private processing = false;
  private disposed = false;

  constructor(
    private readonly store: RecycleBinPurgeStore,
    private readonly purge: (job: RecycleBinPurgeJob) => void | Promise<void>,
    private readonly scheduleImmediate: ScheduleImmediate = callback => setImmediate(callback),
  ) {}

  start(): void {
    if (this.disposed) return;
    if (this.started) return;
    this.started = true;
    this.wake();
  }

  /** Call after durable intent is added. No work starts before start(). */
  wake(): void {
    if (this.disposed || !this.started || this.scheduled || this.processing) return;
    if (this.store.pendingPurgeJobs(this.attempted).length === 0) return;
    this.scheduled = true;
    this.scheduleImmediate(() => {
      this.scheduled = false;
      if (this.disposed || !this.started) return;
      this.processing = true;
      void this.processOne().then(didWork => {
        this.processing = false;
        if (didWork && !this.disposed) this.wake();
      }).catch(error => {
        this.processing = false;
        logger.error(`[recycleBin] Purge queue failed: ${error}`);
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
  }

  private async processOne(): Promise<boolean> {
    const job = this.store.pendingPurgeJobs(this.attempted)[0];
    if (!job) return false;
    try {
      await this.purge(job);
      if (this.disposed) return true;
      this.store.completePurge(job.entry.id);
    } catch (error) {
      this.attempted.add(job.entry.id);
      logger.error(`[recycleBin] Purge failed for ${job.entry.sessionId}; retained for next startup: ${error}`);
    }
    return true;
  }
}
