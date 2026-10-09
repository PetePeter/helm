/**
 * RemoteService — "talk to another PC's sessions". One per Helm, playing both
 * Remote roles over the fleet link:
 *
 *  - OWNER: a RemotePtyHost streams local PTYs to attached peers.
 *  - VIEWER: `open()` attaches to a peer's session and adopts it into the local
 *    PtyManager + SessionManager as an ordinary row (with `remote` set), so the
 *    terminal, dots, bindings, send-text and the phone all work unchanged.
 *
 * Fleet delegates (my AI calls the peer's tools); Remote lets ME drive the
 * peer's CLI directly. It rides the fleet transport, pairing and gate — no new
 * port or crypto. The link manager comes and goes with the fleet toggle, hence
 * `setLinks`.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../../utils/logger.js';
import type { SessionInfo } from '../../types/session.js';
import type { SessionManager } from '../manager.js';
import type { PtyManager } from '../pty-manager.js';
import {
  FLEET_SESSIONS_METHOD,
  MAX_FLEET_SESSIONS,
  MAX_FLEET_SESSION_CLI_TYPE_LENGTH,
  MAX_FLEET_SESSION_ID_LENGTH,
  MAX_FLEET_SESSION_NAME_LENGTH,
  MAX_FLEET_SESSION_STATE_LENGTH,
} from '../../mcp/peer/fleet-sessions.js';
import { RemotePtyHost } from './remote-pty-host.js';
import { RemotePtyProcess } from './remote-pty-process.js';
import { RemoteMethod, isRemoteMethod, requireString, type RemoteAttachResult } from './remote-protocol.js';

/** The slice of PeerLinkManager Remote needs. */
export interface RemoteLinks {
  peerIdFor(peerRef: string): string | undefined;
  call(peerRef: string, method: string, params: unknown): Promise<unknown>;
  notify(peerRef: string, method: string, params: unknown): boolean;
  onlinePeerIds(): string[];
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface RemoteServiceDeps {
  pty: PtyManager;
  sessions: Pick<SessionManager, 'addSession' | 'getSession' | 'getAllSessions' | 'on' | 'off'>;
  coalesceMs?: number;
  /** True only when this peer has an enabled inbound grant from this machine. */
  canSendSessionsToPeer?: (peerId: string) => boolean;
  /** Resolve a CLI type id owned by THIS machine to its peer-facing display name. */
  cliTypeName?: (ref: string) => string | undefined;
}

/** What the peer's `session_create` takes. */
export interface RemoteSpawnArgs {
  cliType: string;
  dirPath: string;
  name?: string;
  initialPrompt?: string;
}

interface PeerNotification { peerId: string; method: string; params: unknown }

/** `name` is the last one the peer knows, so only a real rename is forwarded. */
interface ViewedSession { localId: string; process: RemotePtyProcess; name: string }

export class RemoteService extends EventEmitter {
  private links: RemoteLinks | null = null;
  private readonly host: RemotePtyHost;
  /** Viewer side: `${peerId}\n${remoteSessionId}` → the adopted local session. */
  private readonly viewed = new Map<string, ViewedSession>();
  private readonly sessionPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSessionSnapshots = new Map<string, string>();

  private readonly onNotification = ({ peerId, method, params }: PeerNotification): void => {
    if (method === RemoteMethod.data || method === RemoteMethod.exit) this.onOwnerFrame(peerId, method, params);
    else if (isRemoteMethod(method)) this.host.handleNotification(peerId, method, params);
  };

  private readonly onOffline = ({ peerId }: { peerId: string }): void => {
    this.clearSessionPush(peerId);
    this.lastSessionSnapshots.delete(peerId);
    this.host.detachPeer(peerId);
    for (const view of this.viewsOf(peerId)) view.process.linkLost();
  };

  private readonly onOnline = ({ peerId }: { peerId: string }): void => {
    for (const view of this.viewsOf(peerId)) void view.process.repair();
    this.clearSessionPush(peerId);
    this.lastSessionSnapshots.delete(peerId);
    this.pushSessions(peerId);
  };

  private readonly onSessionAdded = (session: SessionInfo): void => {
    if (!session.remote) this.pushSessions();
  };

  private readonly onSessionRemoved = (event: { session?: SessionInfo }): void => {
    if (!event.session?.remote) this.pushSessions();
  };

  /**
   * A Remote row's name is the PEER's session name: renaming the row here (UI,
   * MCP or phone — they all land in SessionManager) renames it there too, or
   * the two machines disagree about what the session is called.
   */
  private readonly onSessionUpdated = (session: SessionInfo): void => {
    if (!session.remote) {
      this.pushSessions();
      return;
    }
    const view = this.viewed.get(viewKey(session.remote.peerId, session.remote.sessionId));
    if (!view || view.name === session.name) return;
    view.name = session.name;
    const { peerId, sessionId } = session.remote;
    Promise.resolve(this.links?.call(peerId, 'session_rename', { sessionId, newName: session.name }))
      .catch((err) => logger.warn(`[Remote] Rename of ${peerId}/${sessionId} not applied on the peer: ${err instanceof Error ? err.message : String(err)}`));
  };

  constructor(private readonly deps: RemoteServiceDeps) {
    super();
    deps.sessions.on('session:added', this.onSessionAdded);
    deps.sessions.on('session:removed', this.onSessionRemoved);
    deps.sessions.on('session:updated', this.onSessionUpdated);
    this.host = new RemotePtyHost({
      pty: deps.pty,
      send: (peerId, method, params) => this.links?.notify(peerId, method, params) ?? false,
      describe: (sessionId) => {
        const s = deps.sessions.getSession(sessionId);
        return s ? { name: s.name, cliType: s.cliType, ...(s.workingDir ? { workingDir: s.workingDir } : {}) } : undefined;
      },
      coalesceMs: deps.coalesceMs,
    });
  }

  /** Bind to the live fleet link manager (null when fleet is off). */
  setLinks(links: RemoteLinks | null): void {
    if (this.links) {
      this.links.off('peer-notification', this.onNotification);
      this.links.off('peer-link:offline', this.onOffline);
      this.links.off('peer-link:online', this.onOnline);
    }
    for (const timer of this.sessionPushTimers.values()) clearTimeout(timer);
    this.sessionPushTimers.clear();
    this.lastSessionSnapshots.clear();
    this.links = links;
    if (links) {
      links.on('peer-notification', this.onNotification);
      links.on('peer-link:offline', this.onOffline);
      links.on('peer-link:online', this.onOnline);
    }
  }

  /** OWNER: a gated `remote.*` request from a peer (routed here by the gate's dispatch). */
  handleCall(peerId: string, method: string, params: unknown): RemoteAttachResult {
    // A Remote row is itself a view — re-exporting it would chain machines.
    // Answer exactly like a missing session so it can't be probed apart.
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId === 'string' && this.deps.sessions.getSession(sessionId)?.remote) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.host.handleCall(peerId, method, params);
  }

  /** Called only after the shared inbound peer gate accepts fleet.sessions. */
  handleSessionsNotification(peerId: string, params: unknown): void {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const raw = (params as { sessions?: unknown }).sessions;
    if (!Array.isArray(raw)) return;
    const sessions = raw.slice(0, MAX_FLEET_SESSIONS).flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || row.id.length > MAX_FLEET_SESSION_ID_LENGTH
        || typeof row.name !== 'string' || typeof row.cliType !== 'string') return [];
      return [{
        id: row.id,
        name: row.name.slice(0, MAX_FLEET_SESSION_NAME_LENGTH),
        cliType: row.cliType.slice(0, MAX_FLEET_SESSION_CLI_TYPE_LENGTH),
        ...(typeof row.state === 'string' ? { state: row.state.slice(0, MAX_FLEET_SESSION_STATE_LENGTH) } : {}),
        ...(row.activityLevel === 'active' || row.activityLevel === 'inactive' || row.activityLevel === 'idle'
          ? { activityLevel: row.activityLevel }
          : {}),
      }];
    });
    this.emit('peer-sessions-changed', { peerId, sessions });
  }

  /**
   * VIEWER: attach to `remoteSessionId` on `peerRef` (id or alias) and surface it
   * as a local session. Idempotent per remote session.
   */
  async open(peerRef: string, remoteSessionId: string): Promise<SessionInfo> {
    const links = this.links;
    const peerId = links?.peerIdFor(peerRef);
    if (!links || !peerId) throw new Error(`Unknown or unreachable peer: ${peerRef}`);

    const key = viewKey(peerId, remoteSessionId);
    const existing = this.viewed.get(key);
    if (existing) {
      const session = this.deps.sessions.getSession(existing.localId);
      if (session) return session;
    }

    const attach = async (): Promise<RemoteAttachResult> =>
      await this.requireLinks().call(peerId, RemoteMethod.attach, { sessionId: remoteSessionId }) as RemoteAttachResult;
    const attached = await attach();

    const localId = `remote-${randomUUID()}`;
    const process = new RemotePtyProcess({
      send: (method, params) => {
        // A detach is the local row closing: forget the view with it.
        if (method === 'detach') this.viewed.delete(key);
        this.links?.notify(peerId, RemoteMethod[method], { sessionId: remoteSessionId, ...params });
      },
      reattach: attach,
    }, attached);
    this.deps.pty.adopt(localId, process, { cols: attached.cols, rows: attached.rows });
    process.onExit(() => this.viewed.delete(key));
    this.viewed.set(key, { localId, process, name: attached.session.name });
    process.paint(attached);

    const session: SessionInfo = {
      id: localId,
      name: attached.session.name,
      cliType: attached.session.cliType,
      processId: process.pid,
      ...(attached.session.workingDir ? { workingDir: attached.session.workingDir } : {}),
      remote: { peerId, sessionId: remoteSessionId },
      lastOutputAt: Date.now(),
    };
    this.deps.sessions.addSession(session);
    logger.info(`[Remote] Opened ${peerId}/${remoteSessionId} as ${localId}`);
    return session;
  }

  /**
   * VIEWER: start a CLI on `peerRef` (its own `session_create`, through its gate)
   * and open it here. The session lives on the peer; closing this row detaches.
   * If the attach fails the peer's session keeps running, so the error names it
   * for a later Attach… rather than killing work the user just started.
   */
  async spawn(peerRef: string, args: RemoteSpawnArgs): Promise<SessionInfo> {
    const links = this.links;
    const peerId = links?.peerIdFor(peerRef);
    if (!links || !peerId) throw new Error(`Unknown or unreachable peer: ${peerRef}`);
    // MCP callers may pass one of this machine's ids; the peer cannot resolve
    // it locally. Quick Spawn already passes the peer-owned id, which stays as-is.
    const cliType = this.deps.cliTypeName?.(args.cliType) ?? args.cliType;
    const created = await links.call(peerId, 'session_create', { ...args, cliType }) as { id?: unknown } | null;
    const remoteId = created?.id;
    if (typeof remoteId !== 'string' || !remoteId) throw new Error(`Peer ${peerRef} returned no session id`);
    try {
      return await this.open(peerId, remoteId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Started ${remoteId} on ${peerRef} but could not attach: ${reason}`);
    }
  }

  dispose(): void {
    this.deps.sessions.off('session:added', this.onSessionAdded);
    this.deps.sessions.off('session:removed', this.onSessionRemoved);
    this.deps.sessions.off('session:updated', this.onSessionUpdated);
    this.setLinks(null);
    this.host.dispose();
  }

  private onOwnerFrame(peerId: string, method: string, params: unknown): void {
    let remoteSessionId: string;
    try { remoteSessionId = requireString(params, 'sessionId'); } catch { return; }
    const view = this.viewed.get(viewKey(peerId, remoteSessionId));
    if (!view) return;
    const p = params as Record<string, unknown>;
    if (method === RemoteMethod.exit) {
      view.process.exit(typeof p.exitCode === 'number' ? p.exitCode : 0);
    } else if (typeof p.seq === 'number' && typeof p.data === 'string') {
      view.process.receive(p.seq, p.data);
    }
  }

  private viewsOf(peerId: string): ViewedSession[] {
    const prefix = `${peerId}\n`;
    return [...this.viewed].filter(([key]) => key.startsWith(prefix)).map(([, view]) => view);
  }

  private pushSessions(peerId?: string): void {
    const links = this.links;
    if (!links) return;
    const targets = peerId ? [peerId] : links.onlinePeerIds();
    for (const target of targets) {
      if (!this.canSendSessionsToPeer(target)) continue;
      this.clearSessionPush(target);
      const timer = setTimeout(() => {
        this.sessionPushTimers.delete(target);
        const currentLinks = this.links;
        if (!currentLinks || !this.canSendSessionsToPeer(target)) return;
        const sessions = this.localSessionSnapshot();
        const serialized = JSON.stringify(sessions);
        if (this.lastSessionSnapshots.get(target) === serialized) return;
        if (currentLinks.notify(target, FLEET_SESSIONS_METHOD, { sessions })) {
          this.lastSessionSnapshots.set(target, serialized);
        }
      }, this.deps.coalesceMs ?? 50);
      this.sessionPushTimers.set(target, timer);
    }
  }

  private localSessionSnapshot(): Array<Record<string, unknown>> {
    return this.deps.sessions.getAllSessions()
      .filter(session => !session.remote)
      .map(session => ({
        id: session.id,
        name: session.name,
        cliType: session.cliType,
        ...(session.state ? { state: session.state } : {}),
        ...(session.activityLevel ? { activityLevel: session.activityLevel } : {}),
      }));
  }

  private canSendSessionsToPeer(peerId: string): boolean {
    try { return this.deps.canSendSessionsToPeer?.(peerId) ?? true; }
    catch { return false; }
  }

  private clearSessionPush(peerId: string): void {
    const timer = this.sessionPushTimers.get(peerId);
    if (timer !== undefined) clearTimeout(timer);
    this.sessionPushTimers.delete(peerId);
  }

  private requireLinks(): RemoteLinks {
    if (!this.links) throw new Error('Fleet is off');
    return this.links;
  }
}

function viewKey(peerId: string, remoteSessionId: string): string {
  return `${peerId}\n${remoteSessionId}`;
}
