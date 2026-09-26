/**
 * RemotePtyProcess — the VIEWER side of one Remote session: a PtyProcess whose
 * real process lives on a fleet peer. Adopted into the local PtyManager, it
 * makes every downstream consumer (xterm, activity dots, pattern matcher,
 * send-text, bindings) work unchanged.
 *
 * Ordering: owner frames carry a seq. A duplicate/stale frame is dropped; a gap
 * means a frame was lost, so the screen can no longer be trusted — the process
 * asks its controller for a fresh attach and repaints from that snapshot.
 */

import type { PtyProcess } from '../pty-manager.js';
import type { RemoteAttachResult } from './remote-protocol.js';

/** ESC c — full terminal reset, so a repaint never overlays a stale screen. */
const RESET = '\x1bc';
const LINK_LOST_NOTICE = '\r\n\x1b[33m[remote link lost — waiting for the peer]\x1b[0m\r\n';

export interface RemotePtyProcessDeps {
  /** Notify the owner (write/resize/detach) — the session id is filled in here. */
  send: (method: 'write' | 'resize' | 'detach', params: Record<string, unknown>) => void;
  /** Re-run attach against the owner; rejects when the session is gone. */
  reattach: () => Promise<RemoteAttachResult>;
}

export class RemotePtyProcess implements PtyProcess {
  /** No local process exists; 0 marks "remote" wherever a pid is shown. */
  readonly pid = 0;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private seq: number;
  private reattaching = false;
  private exited = false;

  constructor(private readonly deps: RemotePtyProcessDeps, attached: RemoteAttachResult) {
    this.seq = attached.seq;
  }

  onData = (callback: (data: string) => void): void => { this.dataCallbacks.push(callback); };
  onExit = (callback: (e: { exitCode: number; signal?: number }) => void): void => { this.exitCallbacks.push(callback); };

  write(data: string): void { this.deps.send('write', { data }); }
  resize(cols: number, rows: number): void { this.deps.send('resize', { cols, rows }); }
  /** Closing the local view detaches; the owner's process is never killed from here. */
  kill(): void {
    this.exited = true;
    this.deps.send('detach', {});
  }

  /** Paint a snapshot as the initial (or repaired) screen. */
  paint(attached: RemoteAttachResult, reset = false): void {
    this.seq = attached.seq;
    this.emitData((reset ? RESET : '') + attached.snapshot);
  }

  /** An owner output frame. */
  receive(seq: number, data: string): void {
    if (this.reattaching || seq <= this.seq) return;
    if (seq !== this.seq + 1) {
      void this.repair();
      return;
    }
    this.seq = seq;
    this.emitData(data);
  }

  /** The link dropped: say so on screen; `repair()` runs when it returns. */
  linkLost(): void {
    this.emitData(LINK_LOST_NOTICE);
  }

  /** Re-attach and repaint; a session that is gone on the owner ends here. */
  async repair(): Promise<void> {
    if (this.reattaching || this.exited) return;
    this.reattaching = true;
    try {
      const attached = await this.deps.reattach();
      this.reattaching = false;
      this.paint(attached, true);
    } catch {
      this.reattaching = false;
      this.exit(1);
    }
  }

  /** The owner's process exited. */
  exit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCallbacks) cb({ exitCode });
  }

  private emitData(data: string): void {
    if (this.exited || !data) return;
    for (const cb of this.dataCallbacks) cb(data);
  }
}
