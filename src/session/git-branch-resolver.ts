import { execFile } from 'node:child_process';
import { normalizeProjectPath } from './project-identity.js';

interface BranchSnapshot {
  checkedAt: number;
  pending: boolean;
  branch?: string;
}

/** Resolves branches off the session-list hot path and shares work per directory. */
export class GitBranchResolver {
  private readonly snapshots = new Map<string, BranchSnapshot>();

  get(workingDir?: string): string | undefined {
    if (!workingDir) return undefined;

    const key = normalizeProjectPath(workingDir);
    const snapshot = this.snapshots.get(key);
    if (!snapshot || (!snapshot.pending && Date.now() - snapshot.checkedAt >= REFRESH_MS)) {
      this.refresh(key, workingDir);
    }
    return snapshot?.branch;
  }

  private refresh(key: string, workingDir: string): void {
    const snapshot: BranchSnapshot = { checkedAt: Date.now(), pending: true };
    this.snapshots.set(key, snapshot);
    execFile(
      'git',
      ['-C', workingDir, 'branch', '--show-current'],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (this.snapshots.get(key) !== snapshot) return;
        snapshot.pending = false;
        snapshot.checkedAt = Date.now();
        const branch = error ? '' : stdout.trim();
        if (branch && branch !== 'main' && branch !== 'master') snapshot.branch = branch;
        else delete snapshot.branch;
      },
    );
  }
}

const REFRESH_MS = 5_000;
const GIT_TIMEOUT_MS = 1_500;
