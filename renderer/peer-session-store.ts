/** Per-peer session snapshots shared by dynamic Sessions panes. */

export interface PeerSessionRow {
  id: string;
  name: string;
  cliType: string;
  state?: string;
  activityLevel?: string;
}

export interface PeerSessionSnapshot {
  sessions: PeerSessionRow[];
  online: boolean;
  stale: boolean;
}

type Listener = (peerId: string) => void;

export class PeerSessionStore {
  private readonly snapshots = new Map<string, PeerSessionSnapshot>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<Listener>();

  get(peerId: string): PeerSessionSnapshot | undefined {
    return this.snapshots.get(peerId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setOnline(peerId: string, online: boolean): void {
    const current = this.snapshots.get(peerId) ?? { sessions: [], online: false, stale: false };
    if (this.snapshots.has(peerId) && current.online === online) return;
    if (!online) this.advance(peerId);
    this.set(peerId, { ...current, online, stale: online ? current.stale : current.sessions.length > 0 });
  }

  beginRefresh(peerId: string): number {
    const generation = this.advance(peerId);
    const current = this.snapshots.get(peerId) ?? { sessions: [], online: true, stale: false };
    this.set(peerId, { ...current, online: true });
    return generation;
  }

  completeRefresh(peerId: string, generation: number, sessions: PeerSessionRow[]): boolean {
    if (this.generations.get(peerId) !== generation) return false;
    const current = this.snapshots.get(peerId) ?? { sessions: [], online: true, stale: false };
    this.set(peerId, { ...current, sessions: copyRows(sessions), online: true, stale: false });
    return true;
  }

  applyPush(peerId: string, sessions: PeerSessionRow[]): void {
    this.advance(peerId);
    this.set(peerId, { sessions: copyRows(sessions), online: true, stale: false });
  }

  clear(peerId: string): void {
    this.advance(peerId);
    this.snapshots.delete(peerId);
    this.notify(peerId);
  }

  private advance(peerId: string): number {
    const generation = (this.generations.get(peerId) ?? 0) + 1;
    this.generations.set(peerId, generation);
    return generation;
  }

  private set(peerId: string, snapshot: PeerSessionSnapshot): void {
    this.snapshots.set(peerId, snapshot);
    this.notify(peerId);
  }

  private notify(peerId: string): void {
    for (const listener of this.listeners) listener(peerId);
  }
}

export const peerSessionStore = new PeerSessionStore();

function copyRows(sessions: PeerSessionRow[]): PeerSessionRow[] {
  return sessions.map(session => ({ ...session }));
}
