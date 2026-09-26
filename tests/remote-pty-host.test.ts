/**
 * RemotePtyHost — the OWNER side of Remote: streams a real local PTY to attached
 * fleet peers and applies their keystrokes. Driven through a real PtyManager with
 * a fake PTY factory; the peer transport is a recording `send` sink.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { RemotePtyHost } from '../src/session/remote/remote-pty-host.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

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

const COALESCE_MS = 16;

describe('RemotePtyHost', () => {
  let ptys: FakePty[];
  let manager: PtyManager;
  let sent: Array<{ peerId: string; method: string; params: any }>;
  let host: RemotePtyHost;

  const spawn = (sessionId: string): FakePty => {
    manager.spawn({ sessionId, cols: 100, rows: 40 });
    const pty = ptys[ptys.length - 1];
    pty.writes = []; // drop the (empty) initial-command bookkeeping
    return pty;
  };
  const dataFrames = () => sent.filter((f) => f.method === 'remote.data');

  beforeEach(() => {
    vi.useFakeTimers();
    ptys = [];
    const factory: PtyFactory = { spawn: () => { const p = new FakePty(); ptys.push(p); return p; } };
    manager = new PtyManager(factory);
    sent = [];
    host = new RemotePtyHost({
      pty: manager,
      send: (peerId, method, params) => { sent.push({ peerId, method, params }); return true; },
      coalesceMs: COALESCE_MS,
    });
  });

  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  it('attach returns the existing screen as a raw snapshot plus the PTY size', () => {
    const pty = spawn('s1');
    pty.emitData('\x1b[32mhello\x1b[0m\r\nworld');

    const result = host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });

    expect(result).toMatchObject({ seq: 0, cols: 100, rows: 40 });
    expect(result.snapshot).toContain('\x1b[32mhello');
    expect(result.snapshot).toContain('world');
  });

  it('rejects attaching to a session that does not exist', () => {
    expect(() => host.handleCall('peerA', 'remote.attach', { sessionId: 'nope' })).toThrow(/not found/i);
  });

  it('streams output to attached peers as seq-numbered frames, coalescing bursts', () => {
    const pty = spawn('s1');
    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });

    pty.emitData('a');
    pty.emitData('b');
    vi.advanceTimersByTime(COALESCE_MS);
    pty.emitData('c');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(dataFrames().map((f) => f.params)).toEqual([
      { sessionId: 's1', seq: 1, data: 'ab' },
      { sessionId: 's1', seq: 2, data: 'c' },
    ]);
    expect(dataFrames().every((f) => f.peerId === 'peerA')).toBe(true);
  });

  it('output produced before an attach is in the snapshot, never re-sent as a frame', () => {
    const pty = spawn('s1');
    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });
    pty.emitData('early');
    const second = host.handleCall('peerB', 'remote.attach', { sessionId: 's1' });
    vi.advanceTimersByTime(COALESCE_MS);

    expect(second.snapshot).toContain('early');
    expect(dataFrames().filter((f) => f.peerId === 'peerB')).toEqual([]);
    expect(dataFrames().filter((f) => f.peerId === 'peerA').map((f) => f.params.data)).toEqual(['early']);
  });

  it('applies writes and resizes only from a peer attached to that session', () => {
    const pty = spawn('s1');
    host.handleNotification('peerA', 'remote.write', { sessionId: 's1', data: 'sneaky' });
    expect(pty.writes).toEqual([]);

    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });
    host.handleNotification('peerA', 'remote.write', { sessionId: 's1', data: 'y\r' });
    host.handleNotification('peerA', 'remote.resize', { sessionId: 's1', cols: 80, rows: 24 });
    host.handleNotification('peerB', 'remote.write', { sessionId: 's1', data: 'other peer' });

    expect(pty.writes).toEqual(['y\r']);
    expect(pty.resizes).toContainEqual([80, 24]);
  });

  it('detach and link loss stop the stream but never kill the PTY', () => {
    const pty = spawn('s1');
    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });
    host.handleCall('peerB', 'remote.attach', { sessionId: 's1' });

    host.handleNotification('peerA', 'remote.detach', { sessionId: 's1' });
    host.detachPeer('peerB');
    pty.emitData('after');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(dataFrames()).toEqual([]);
    expect(pty.killed).toBe(false);
    expect(manager.has('s1')).toBe(true);
  });

  it('a PTY exit tells every attached peer, then forgets the session', () => {
    const pty = spawn('s1');
    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });
    host.handleCall('peerB', 'remote.attach', { sessionId: 's1' });

    pty.emitExit(3);

    const exits = sent.filter((f) => f.method === 'remote.exit');
    expect(exits.map((f) => [f.peerId, f.params])).toEqual([
      ['peerA', { sessionId: 's1', exitCode: 3 }],
      ['peerB', { sessionId: 's1', exitCode: 3 }],
    ]);
    host.handleNotification('peerA', 'remote.write', { sessionId: 's1', data: 'x' });
    expect(pty.writes).toEqual([]);
  });

  it('a peer whose link is gone (send returns false) is dropped from the session', () => {
    const pty = spawn('s1');
    let online = true;
    host.dispose();
    host = new RemotePtyHost({
      pty: manager,
      send: (peerId, method, params) => { if (online) sent.push({ peerId, method, params }); return online; },
      coalesceMs: COALESCE_MS,
    });
    host.handleCall('peerA', 'remote.attach', { sessionId: 's1' });
    online = false;
    pty.emitData('lost');
    vi.advanceTimersByTime(COALESCE_MS);
    online = true;
    pty.emitData('back');
    vi.advanceTimersByTime(COALESCE_MS);

    expect(dataFrames()).toEqual([]);
  });

  it('rejects unknown remote methods', () => {
    expect(() => host.handleCall('peerA', 'remote.kill', { sessionId: 's1' })).toThrow(/unknown/i);
  });
});
