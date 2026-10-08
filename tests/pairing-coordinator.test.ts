/**
 * PairingCoordinator tests — single-active-session, timer-driven 180s expiry, and
 * one decision per session. A fake PeerPairing factory isolates the coordinator's
 * session logic; fake timers drive the expiry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { PairingCoordinator, PAIRING_SESSION_TTL_MS } from '../src/mcp/peer/pairing-coordinator.js';

/** A fake pairing that lets tests drive begin/accept/reject/cancel + events. */
class FakePairing extends EventEmitter {
  began = false;
  accepted = 0;
  rejected = 0;
  cancelled: string[] = [];
  begin(): void { this.began = true; }
  accept(): void { this.accepted++; }
  reject(): void { this.rejected++; }
  cancel(reason = 'cancelled'): void { this.cancelled.push(reason); this.emit('failed', { reason }); }
  getSas(): string | null { return '123456'; }
}

const peerInfo = (machineId = 'peer-1') => ({
  machineId, certFp: 'FP', alias: 'a', address: '10.0.0.1:47474',
});

function makeCoordinator() {
  const created: FakePairing[] = [];
  const coord = new PairingCoordinator({
    createPairing: () => {
      const p = new FakePairing();
      created.push(p);
      return p as any;
    },
  });
  return { coord, created };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('single active session', () => {
  it('starts one session; a second start while active is rejected', () => {
    const { coord } = makeCoordinator();
    expect(coord.start(peerInfo('a')).ok).toBe(true);
    expect(coord.start(peerInfo('b')).ok).toBe(false);
  });

  it('after the active session is cancelled a new one may start', () => {
    const { coord, created } = makeCoordinator();
    coord.start(peerInfo('a'));
    coord.cancel();
    expect(created[0].cancelled).toEqual(['cancelled']);
    expect(coord.start(peerInfo('b')).ok).toBe(true);
  });

  it('success consumes the session so a new one may start', () => {
    const { coord, created } = makeCoordinator();
    coord.start(peerInfo('a'));
    created[0].emit('paired', { peerId: 'x', machineId: 'a' });
    expect(coord.start(peerInfo('b')).ok).toBe(true);
  });

  it('a peer that drops frees the slot for the next inbound pairing at once', () => {
    const { coord } = makeCoordinator();
    const first = new FakePairing();
    expect(coord.startInbound(peerInfo('a'), 's-1', first as any).ok).toBe(true);
    first.cancel('peer-disconnected');
    expect(coord.startInbound(peerInfo('a'), 's-2', new FakePairing() as any).ok).toBe(true);
  });

  // Regression: three cancelled attempts used to lock the user out of their own
  // machine for 15 minutes.
  it('repeated cancels never block a retry against the same peer', () => {
    const { coord } = makeCoordinator();
    for (let i = 0; i < 20; i++) {
      expect(coord.start(peerInfo('tavopc')).ok).toBe(true);
      coord.cancel();
    }
  });
});

describe('180s expiry', () => {
  it('expires on its own timer, with no further call needed to notice', () => {
    const { coord, created } = makeCoordinator();
    coord.start(peerInfo('a'));

    vi.advanceTimersByTime(PAIRING_SESSION_TTL_MS - 1);
    expect(created[0].cancelled).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(created[0].cancelled).toEqual(['expired']);
    expect(coord.listActive()).toEqual([]);
  });

  it('a settled session leaves no timer behind to kill the next one', () => {
    const { coord, created } = makeCoordinator();
    coord.start(peerInfo('a'));
    vi.advanceTimersByTime(PAIRING_SESSION_TTL_MS - 1000);
    coord.cancel();

    coord.start(peerInfo('b'));
    vi.advanceTimersByTime(2000); // past the FIRST session's deadline
    expect(created[1].cancelled).toEqual([]);
    expect(coord.listActive()).toHaveLength(1);
  });
});

describe('one decision per session', () => {
  it('confirm(accept) then a second decision is ignored', () => {
    const { coord, created } = makeCoordinator();
    const started = coord.start(peerInfo('a'));
    coord.confirm(started.sessionId!, true);
    coord.confirm(started.sessionId!, false);
    expect(created[0].accepted).toBe(1);
    expect(created[0].rejected).toBe(0);
  });

  it('confirm on an unknown sessionId is a no-op', () => {
    const { coord, created } = makeCoordinator();
    coord.start(peerInfo('a'));
    coord.confirm('nope', true);
    expect(created[0].accepted).toBe(0);
  });
});
