/**
 * Remote end-to-end over a loopback: two real RemoteServices — "host" (owns a
 * real PTY) and "viewer" (adopts it) — each with a real PtyManager and a real
 * SessionManager, joined by an in-memory fleet link. Only the node-pty process
 * and the sessions file are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { SessionManager } from '../src/session/manager.js';
import { RemoteService, type RemoteLinks } from '../src/session/remote/remote-service.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', () => ({ saveSessions: vi.fn(), loadSessions: () => [] }));

class FakePty implements PtyProcess {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number }) => void = () => {};
  write(d: string): void { this.writes.push(d); }
  resize(c: number, r: number): void { this.resizes.push([c, r]); }
  kill(): void { this.killed = true; }
  onData = (cb: (d: string) => void): void => { this.dataCb = cb; };
  onExit = (cb: (e: { exitCode: number }) => void): void => { this.exitCb = cb; };
  emitData(d: string): void { this.dataCb(d); }
  emitExit(code: number): void { this.exitCb({ exitCode: code }); }
}

/** One machine's view of the fleet link to the other: synchronous, in-memory. */
class LoopLinks extends EventEmitter implements RemoteLinks {
  other!: LoopLinks;
  online = true;
  /** When set, the next outbound notification whose method matches is dropped. */
  dropNext?: string;
  constructor(readonly selfId: string, readonly peerId: string, private readonly callee: () => RemoteService) { super(); }
  peerIdFor(ref: string): string | undefined { return ref === this.peerId || ref === 'Host-PC' ? this.peerId : undefined; }
  async call(_ref: string, method: string, params: unknown): Promise<unknown> {
    if (!this.online) throw new Error('No live link');
    return this.callee().handleCall(this.selfId, method, params);
  }
  notify(_ref: string, method: string, params: unknown): boolean {
    if (!this.online) return false;
    if (this.dropNext === method) { this.dropNext = undefined; return true; }
    this.other.emit('peer-notification', { peerId: this.selfId, method, params });
    return true;
  }
  setOnline(online: boolean): void {
    for (const side of [this, this.other]) side.online = online;
    this.emit(online ? 'peer-link:online' : 'peer-link:offline', { peerId: this.peerId });
    this.other.emit(online ? 'peer-link:online' : 'peer-link:offline', { peerId: this.selfId });
  }
}

const COALESCE_MS = 16;

describe('Remote (host ⇄ viewer loopback)', () => {
  let hostPty: FakePty;
  let hostPtys: PtyManager;
  let viewerPtys: PtyManager;
  let viewerSessions: SessionManager;
  let host: RemoteService;
  let viewer: RemoteService;
  let hostLinks: LoopLinks;
  let viewerLinks: LoopLinks;
  let screen: string;

  const flush = () => vi.advanceTimersByTime(COALESCE_MS);

  beforeEach(() => {
    vi.useFakeTimers();
    const factory: PtyFactory = { spawn: () => (hostPty = new FakePty()) };
    hostPtys = new PtyManager(factory);
    hostPtys.spawn({ sessionId: 'h1', cols: 100, rows: 40 });
    hostPty.writes = [];
    const hostSessions = new SessionManager();
    hostSessions.addSession({ id: 'h1', name: 'builder', cliType: 'claude-code', processId: 42, workingDir: 'C:\\work' });

    viewerPtys = new PtyManager({ spawn: () => { throw new Error('viewer never spawns'); } });
    viewerSessions = new SessionManager();

    host = new RemoteService({ pty: hostPtys, sessions: hostSessions, coalesceMs: COALESCE_MS });
    viewer = new RemoteService({ pty: viewerPtys, sessions: viewerSessions, coalesceMs: COALESCE_MS });
    hostLinks = new LoopLinks('HOST', 'VIEWER', () => viewer);
    viewerLinks = new LoopLinks('VIEWER', 'HOST', () => host);
    hostLinks.other = viewerLinks;
    viewerLinks.other = hostLinks;
    host.setLinks(hostLinks);
    viewer.setLinks(viewerLinks);

    screen = '';
    viewerPtys.on('data', (_id: string, d: string) => { screen += d; });
  });

  afterEach(() => {
    host.dispose();
    viewer.dispose();
    vi.useRealTimers();
  });

  it('open() adds a local session mirroring the host session, showing its current screen', async () => {
    hostPty.emitData('ready> ');

    const session = await viewer.open('Host-PC', 'h1');

    expect(session).toMatchObject({ name: 'builder', cliType: 'claude-code', remote: { peerId: 'HOST', sessionId: 'h1' } });
    expect(session.cliSessionName).toBeUndefined(); // never recycle-binned / resume-spawned locally
    expect(viewerSessions.getSession(session.id)).toBeTruthy();
    expect(viewerPtys.getSize(session.id)).toEqual({ cols: 100, rows: 40 });
    expect(screen).toContain('ready> ');
  });

  it('keystrokes typed on the viewer reach the host PTY; host output reaches the viewer', async () => {
    const { id } = await viewer.open('HOST', 'h1');

    viewerPtys.write(id, 'y\r');
    hostPty.emitData('approved');
    flush();

    expect(hostPty.writes).toEqual(['y\r']);
    expect(screen).toContain('approved');
    expect(viewerPtys.getTerminalTail(id, 5, 'stripped').stripped?.join('')).toContain('approved');
  });

  it('a lost frame (seq gap) re-attaches and repaints from a fresh snapshot', async () => {
    const { id } = await viewer.open('HOST', 'h1');
    hostLinks.dropNext = 'remote.data';
    hostPty.emitData('LOST');
    flush();
    hostPty.emitData('NEXT');
    flush();
    await vi.runAllTimersAsync();

    expect(screen).toContain('\x1bc'); // terminal reset before the repaint
    const afterReset = screen.slice(screen.lastIndexOf('\x1bc'));
    expect(afterReset).toContain('LOST');
    expect(afterReset).toContain('NEXT');
    expect(viewerPtys.has(id)).toBe(true);
  });

  it('closing the viewer session detaches — the host PTY keeps running', async () => {
    const { id } = await viewer.open('HOST', 'h1');

    viewerPtys.kill(id);
    hostPty.emitData('still alive');
    flush();

    expect(hostPty.killed).toBe(false);
    expect(hostPtys.has('h1')).toBe(true);
    expect(screen).not.toContain('still alive');
    const reopened = await viewer.open('HOST', 'h1');
    expect(reopened.id).not.toBe(id); // the closed view was forgotten, not reused
  });

  it('the host PTY exiting ends the viewer session', async () => {
    const { id } = await viewer.open('HOST', 'h1');
    const exits: string[] = [];
    viewerPtys.on('exit', (sid: string) => exits.push(sid));

    hostPty.emitExit(0);

    expect(exits).toEqual([id]);
  });

  it('survives a link drop: shows a notice, then re-attaches when the peer returns', async () => {
    const { id } = await viewer.open('HOST', 'h1');

    viewerLinks.setOnline(false);
    expect(screen).toMatch(/remote link lost/i);
    hostPty.emitData('while away');
    viewerLinks.setOnline(true);
    await vi.runAllTimersAsync();
    hostPty.emitData(' and after');
    flush();

    expect(viewerPtys.has(id)).toBe(true);
    const afterReset = screen.slice(screen.lastIndexOf('\x1bc'));
    expect(afterReset).toContain('while away');
    expect(afterReset).toContain(' and after');
  });

  it('rejects opening an unknown peer or a session the host does not have', async () => {
    await expect(viewer.open('nobody', 'h1')).rejects.toThrow(/peer/i);
    await expect(viewer.open('HOST', 'missing')).rejects.toThrow(/not found/i);
    expect(viewerSessions.getAllSessions()).toEqual([]);
  });

  it('a Remote row is never re-exported: attaching to it answers not-found (no chains)', async () => {
    const { id } = await viewer.open('HOST', 'h1');
    await expect(host.open('VIEWER', id)).rejects.toThrow(/not found/i);
  });

  it('opening the same host session twice returns the existing local session', async () => {
    const first = await viewer.open('HOST', 'h1');
    const second = await viewer.open('HOST', 'h1');
    expect(second.id).toBe(first.id);
    expect(viewerSessions.getAllSessions()).toHaveLength(1);
  });
});
