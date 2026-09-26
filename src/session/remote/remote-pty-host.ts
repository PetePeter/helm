/**
 * RemotePtyHost — the OWNER side of Remote. Streams a local PTY's output to the
 * fleet peers attached to it and applies their keystrokes.
 *
 * Authority model: `remote.attach` arrives as a request through InboundCallGate
 * (allow-list, rate limit, audit). Every later notification from that peer is
 * honoured ONLY for sessions it is attached to — the attach is the grant, so an
 * unattached peer cannot write, resize or probe. A peer never kills a PTY here:
 * detach and link loss end the stream, the process lives on.
 *
 * Output is coalesced per session into one frame per `coalesceMs`, so a flood
 * of tiny PTY chunks can't swamp the link with a frame per byte.
 */

import { logger } from '../../utils/logger.js';
import type { PtyManager } from '../pty-manager.js';
import { RemoteMethod, requireString, type RemoteAttachResult, type RemoteSessionLabel } from './remote-protocol.js';

/** Lines of raw scrollback handed to a newly attached viewer. */
const SNAPSHOT_LINES = 500;
const DEFAULT_COALESCE_MS = 16;

type HostPty = Pick<PtyManager, 'on' | 'off' | 'has' | 'write' | 'resize' | 'getSize' | 'getTerminalTail' | 'nudgeResize'>;

export interface RemotePtyHostDeps {
  pty: HostPty;
  /** Notify a peer; false means no live link (the peer is dropped). */
  send: (peerId: string, method: string, params: unknown) => boolean;
  /** The owner's label for a session; unknown sessions fall back to their id. */
  describe?: (sessionId: string) => RemoteSessionLabel | undefined;
  coalesceMs?: number;
}

interface HostedSession {
  viewers: Set<string>;
  seq: number;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RemotePtyHost {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly coalesceMs: number;

  private readonly onData = (sessionId: string, data: string): void => {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    hosted.pending += data;
    hosted.timer ??= setTimeout(() => this.flush(sessionId), this.coalesceMs);
  };

  private readonly onExit = (sessionId: string, exitCode: number): void => {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    this.flush(sessionId);
    for (const peerId of hosted.viewers) this.deps.send(peerId, RemoteMethod.exit, { sessionId, exitCode });
    this.forget(sessionId);
  };

  constructor(private readonly deps: RemotePtyHostDeps) {
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
    deps.pty.on('data', this.onData);
    deps.pty.on('exit', this.onExit);
  }

  /** Gated request entry point (reached only through InboundCallGate). */
  handleCall(peerId: string, method: string, params: unknown): RemoteAttachResult {
    if (method !== RemoteMethod.attach) throw new Error(`Unknown remote method: ${method}`);
    return this.attach(peerId, requireString(params, 'sessionId'));
  }

  /** Ungated notification entry point — honoured only for attached sessions. */
  handleNotification(peerId: string, method: string, params: unknown): void {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string' || !this.sessions.get(sessionId)?.viewers.has(peerId)) return;
    const p = params as Record<string, unknown>;
    switch (method) {
      case RemoteMethod.write:
        if (typeof p.data === 'string') this.deps.pty.write(sessionId, p.data);
        break;
      case RemoteMethod.resize:
        if (isDimension(p.cols) && isDimension(p.rows)) this.deps.pty.resize(sessionId, p.cols, p.rows);
        break;
      case RemoteMethod.detach:
        this.removeViewer(sessionId, peerId);
        break;
    }
  }

  /** The peer's link is gone (or the peer was disabled): stop streaming to it. */
  detachPeer(peerId: string): void {
    for (const sessionId of [...this.sessions.keys()]) this.removeViewer(sessionId, peerId);
  }

  dispose(): void {
    this.deps.pty.off('data', this.onData);
    this.deps.pty.off('exit', this.onExit);
    for (const sessionId of [...this.sessions.keys()]) this.forget(sessionId);
  }

  private attach(peerId: string, sessionId: string): RemoteAttachResult {
    const size = this.deps.pty.getSize(sessionId);
    if (!this.deps.pty.has(sessionId) || !size) throw new Error(`Session not found: ${sessionId}`);

    let hosted = this.sessions.get(sessionId);
    if (!hosted) {
      hosted = { viewers: new Set(), seq: 0, pending: '', timer: null };
      this.sessions.set(sessionId, hosted);
    }
    // Pending output is already in the scrollback the snapshot reads: hand it to
    // the existing viewers now so the newcomer never receives it twice.
    this.flush(sessionId);
    hosted.viewers.add(peerId);

    const snapshot = (this.deps.pty.getTerminalTail(sessionId, SNAPSHOT_LINES, 'raw').raw ?? []).join('\r\n');
    // A full-screen TUI repaints on SIGWINCH, replacing the line-based snapshot
    // with its real current screen on the viewer.
    void this.deps.pty.nudgeResize(sessionId);
    logger.info(`[RemotePtyHost] Peer ${peerId} attached to ${sessionId}`);
    const session = this.deps.describe?.(sessionId) ?? { name: sessionId, cliType: 'unknown' };
    return { snapshot, seq: hosted.seq, ...size, session };
  }

  private flush(sessionId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    if (hosted.timer) { clearTimeout(hosted.timer); hosted.timer = null; }
    if (!hosted.pending) return;
    const frame = { sessionId, seq: ++hosted.seq, data: hosted.pending };
    hosted.pending = '';
    for (const peerId of [...hosted.viewers]) {
      if (!this.deps.send(peerId, RemoteMethod.data, frame)) this.removeViewer(sessionId, peerId);
    }
  }

  private removeViewer(sessionId: string, peerId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted?.viewers.delete(peerId)) return;
    logger.info(`[RemotePtyHost] Peer ${peerId} detached from ${sessionId}`);
    if (hosted.viewers.size === 0) this.forget(sessionId);
  }

  private forget(sessionId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (hosted?.timer) clearTimeout(hosted.timer);
    this.sessions.delete(sessionId);
  }
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000;
}
