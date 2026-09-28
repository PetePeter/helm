/**
 * PeerPairing state-machine tests — TWO real PeerPairing instances (initiator +
 * responder) wired by an in-memory channel, with REAL X25519 crypto and REAL
 * PinnedCertStore / SecretStore / PeerConfigManager (fakes only for persist sinks
 * and the clock). Fakes > mocks: we assert observable persisted state.
 *
 * SECURITY-CRITICAL: these tests are the safety net for the SAS pairing protocol.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { PeerPairing, type PairingChannel, type PairingMessage } from '../src/mcp/peer/peer-pairing.js';
import { PinnedCertStore } from '../src/mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';

/** A directed in-memory channel: what you send lands on the peer's handler. */
class Wire implements PairingChannel {
  peer!: { handleMessage(msg: PairingMessage): void };
  sent: PairingMessage[] = [];
  /** When set, transforms/drops the outgoing message (MITM/tamper simulation). */
  intercept: ((m: PairingMessage) => PairingMessage | null) | null = null;

  send(msg: PairingMessage): void {
    this.sent.push(msg);
    const out = this.intercept ? this.intercept(msg) : msg;
    if (out) queueMicrotask(() => this.peer.handleMessage(out));
  }
}

interface Side {
  pairing: PeerPairing;
  pins: PinnedCertStore;
  secrets: SecretStore;
  peers: PeerConfigManager;
  wire: Wire;
  sas: string[];
  paired: any[];
  failed: any[];
}

const SESSION_ID = 'session-abc';
const I = { machineId: 'machine-I', certFp: 'FP-INITIATOR' };
const R = { machineId: 'machine-R', certFp: 'FP-RESPONDER' };

function makeSide(role: 'initiator' | 'responder', wire: Wire, clock: () => number): Side {
  const pins = new PinnedCertStore();
  const secrets = new SecretStore();
  const peers = new PeerConfigManager(undefined, clock);
  const self = role === 'initiator' ? I : R;
  const other = role === 'initiator' ? R : I;

  const pairing = new PeerPairing({
    role,
    sessionId: SESSION_ID,
    channel: wire,
    now: clock,
    pinnedCertStore: pins,
    secretStore: secrets,
    peerConfigManager: peers,
    self: { machineId: self.machineId, certFp: self.certFp },
    peer: { machineId: other.machineId, certFp: other.certFp, alias: `alias-${other.machineId}`, address: '10.0.0.1:47474' },
  });

  const side: Side = { pairing, pins, secrets, peers, wire, sas: [], paired: [], failed: [] };
  pairing.on('sas', (code: string) => side.sas.push(code));
  pairing.on('paired', (info: any) => side.paired.push(info));
  pairing.on('failed', (info: any) => side.failed.push(info));
  return side;
}

function pair(clock: () => number = () => 1000) {
  const wireI = new Wire();
  const wireR = new Wire();
  const initiator = makeSide('initiator', wireI, clock);
  const responder = makeSide('responder', wireR, clock);
  wireI.peer = responder.pairing;
  wireR.peer = initiator.pairing;
  return { initiator, responder };
}

/** Flush the microtask queue so queued channel deliveries settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('PeerPairing happy path', () => {
  it('both sides derive the SAME 6-digit SAS, then both accept → both paired identically', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();

    // Both surfaced a SAS and they MATCH (no MITM).
    expect(initiator.sas).toHaveLength(1);
    expect(responder.sas).toHaveLength(1);
    expect(initiator.sas[0]).toMatch(/^\d{6}$/);
    expect(initiator.sas[0]).toBe(responder.sas[0]);

    // User confirms on both machines.
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();

    expect(initiator.paired).toHaveLength(1);
    expect(responder.paired).toHaveLength(1);

    // IDENTICAL psk stored on both sides.
    const iPeer = initiator.peers.list()[0];
    const rPeer = responder.peers.list()[0];
    const iPsk = initiator.secrets.get(iPeer.pskRef)!;
    const rPsk = responder.secrets.get(rPeer.pskRef)!;
    expect(iPsk).toHaveLength(32);
    expect(iPsk.equals(rPsk)).toBe(true);

    // Symmetric bidirectional PeerConfig written on both, keyed to the peer machineId.
    expect(iPeer.direction).toBe('bidirectional');
    expect(rPeer.direction).toBe('bidirectional');
    expect(iPeer.machineId).toBe(R.machineId);
    expect(rPeer.machineId).toBe(I.machineId);

    // Peer cert fingerprint pinned on both.
    expect(initiator.pins.get(iPeer.id)).toBe(R.certFp.toUpperCase());
    expect(responder.pins.get(rPeer.id)).toBe(I.certFp.toUpperCase());
  });

  it('deny-by-default: the freshly paired PeerConfig has an empty allow-list', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();
    expect(initiator.peers.list()[0].inbound).toBe(false);
  });

  it('zeroes the raw DH shared secret on success (terminal state holds no secret)', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();
    // Secret is live while the SAS is being compared.
    expect(initiator.pairing.hasSharedSecretInMemory()).toBe(true);

    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();

    expect(initiator.paired).toHaveLength(1);
    expect(responder.paired).toHaveLength(1);
    // After a successful pairing neither instance retains the DH secret.
    expect(initiator.pairing.hasSharedSecretInMemory()).toBe(false);
    expect(responder.pairing.hasSharedSecretInMemory()).toBe(false);
    // But the derived PSK IS safely in the secret store.
    const peer = initiator.peers.list()[0];
    expect(initiator.secrets.get(peer.pskRef)).toHaveLength(32);
  });
});

describe('PeerPairing abort paths persist NOTHING', () => {
  it('user rejects (SAS mismatch) → nothing persisted on either side', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();

    initiator.pairing.reject();
    responder.pairing.reject();
    await flush();

    expect(initiator.peers.list()).toHaveLength(0);
    expect(responder.peers.list()).toHaveLength(0);
    expect(initiator.pins.list()).toHaveLength(0);
    expect(responder.pins.list()).toHaveLength(0);
    expect(initiator.secrets.exportAll()).toEqual({});
    expect(responder.secrets.exportAll()).toEqual({});
    expect(initiator.failed.length + responder.failed.length).toBeGreaterThan(0);
  });

  it('one side rejecting → the other never finalizes (no valid confirm-MAC arrives)', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();

    initiator.pairing.accept();     // initiator says yes
    responder.pairing.reject();     // responder says no
    await flush();

    // Initiator sent its confirm, but responder never confirms → initiator not paired.
    expect(initiator.paired).toHaveLength(0);
    expect(initiator.peers.list()).toHaveLength(0);
    expect(responder.peers.list()).toHaveLength(0);
  });

  it('commitment mismatch (tampered reveal) → abort, nothing persisted', async () => {
    const { initiator, responder } = pair();
    // Tamper the initiator's REVEAL so it no longer matches its earlier commitment.
    initiator.wire.intercept = (m) => {
      if (m.step === 'reveal') {
        const bad = { ...m, nonce: Buffer.alloc(32, 0xff).toString('base64') };
        return bad as PairingMessage;
      }
      return m;
    };
    initiator.pairing.begin();
    await flush();

    expect(responder.failed.length).toBeGreaterThan(0);
    expect(responder.peers.list()).toHaveLength(0);
    expect(responder.pins.list()).toHaveLength(0);
    expect(responder.secrets.exportAll()).toEqual({});
  });

  it('out-of-order confirm (before reveals complete) → abort, nothing persisted', async () => {
    const { responder } = pair();
    // Inject a confirm frame directly into the responder before any reveal has
    // been exchanged (shared/transcript not yet derived).
    responder.pairing.handleMessage({
      t: 'pair', step: 'confirm', sessionId: SESSION_ID, mac: Buffer.alloc(32, 7).toString('base64'),
    });

    expect(responder.failed).toHaveLength(1);
    expect(responder.failed[0].reason).toBe('out-of-order-confirm');
    expect(responder.peers.list()).toHaveLength(0);
    expect(responder.pins.list()).toHaveLength(0);
    expect(responder.secrets.exportAll()).toEqual({});
  });
});

describe('PeerPairing MITM (genuine relay through real crypto)', () => {
  it('a relaying attacker forces DIFFERENT SAS on the two ends — the human comparison catches it', async () => {
    // Topology: real I <──> M <──> real R. The attacker M runs TWO real
    // PeerPairing instances with its OWN ephemeral keypairs+nonces:
    //   mAsResponder — completes the handshake with the real I (plays R's role)
    //   mAsInitiator — completes the handshake with the real R (plays I's role)
    // M IMPERSONATES the far identity to each victim (so the identity fields in the
    // transcript match on both ends), but each half uses M's distinct ephemeral
    // key material → the two ECDH secrets differ → the two SAS codes diverge.
    //
    // Commit-then-reveal is what forces this: M must send its commitment (binding
    // its key) to each victim BEFORE it sees that victim's reveal, so it cannot
    // grind its keys after the fact to make SAS_I === SAS_R.
    const clock = () => 1000;

    // --- Real victims ---------------------------------------------------------
    const wireI = new Wire(); // I's outbound channel (delivered to M-as-responder)
    const wireR = new Wire(); // R's outbound channel (delivered to M-as-initiator)
    const initiator = makeSide('initiator', wireI, clock); // real I, peer identity = R
    const responder = makeSide('responder', wireR, clock);  // real R, peer identity = I

    // --- Attacker M: two independent pairing instances ------------------------
    // Toward I, M pretends to BE R (peer = I, self advertises R's identity).
    const mWireTowardI = new Wire();
    const mAsResponder = new PeerPairing({
      role: 'responder',
      sessionId: SESSION_ID,
      channel: mWireTowardI,
      now: clock,
      pinnedCertStore: new PinnedCertStore(),
      secretStore: new SecretStore(),
      peerConfigManager: new PeerConfigManager(undefined, clock),
      // M impersonates R's identity to the real I, and treats I as its peer.
      self: { machineId: R.machineId, certFp: R.certFp },
      peer: { machineId: I.machineId, certFp: I.certFp, alias: 'alias-I', address: '10.0.0.1:47474' },
    });

    // Toward R, M pretends to BE I (peer = R, self advertises I's identity).
    const mWireTowardR = new Wire();
    const mAsInitiator = new PeerPairing({
      role: 'initiator',
      sessionId: SESSION_ID,
      channel: mWireTowardR,
      now: clock,
      pinnedCertStore: new PinnedCertStore(),
      secretStore: new SecretStore(),
      peerConfigManager: new PeerConfigManager(undefined, clock),
      self: { machineId: I.machineId, certFp: I.certFp },
      peer: { machineId: R.machineId, certFp: R.certFp, alias: 'alias-R', address: '10.0.0.2:47474' },
    });

    const mSasTowardI: string[] = [];
    const mSasTowardR: string[] = [];
    mAsResponder.on('sas', (s: string) => mSasTowardI.push(s));
    mAsInitiator.on('sas', (s: string) => mSasTowardR.push(s));

    // --- Wire the relay -------------------------------------------------------
    // I's frames go to M-as-responder; M-as-responder's frames go back to I.
    wireI.peer = mAsResponder;
    mWireTowardI.peer = initiator.pairing;
    // R's frames go to M-as-initiator; M-as-initiator's frames go back to R.
    wireR.peer = mAsInitiator;
    mWireTowardR.peer = responder.pairing;

    // Kick off BOTH legs. Real I initiates toward M; M initiates toward real R.
    initiator.pairing.begin();
    mAsInitiator.begin();
    await flush();

    // Every party derived a SAS through the real protocol (no hypothetical maths).
    expect(initiator.sas).toHaveLength(1);
    expect(responder.sas).toHaveLength(1);
    expect(mSasTowardI).toHaveLength(1);
    expect(mSasTowardR).toHaveLength(1);

    // CORE PROPERTY: the code shown to the real I and the code shown to the real R
    // DIFFER — a human comparing the two 6-digit numbers would reject the pairing.
    expect(initiator.sas[0]).toMatch(/^\d{6}$/);
    expect(responder.sas[0]).toMatch(/^\d{6}$/);
    expect(initiator.sas[0]).not.toBe(responder.sas[0]);

    // Each victim's SAS matches ITS attacker leg (the relay is internally valid —
    // this is why confirm-MAC alone cannot detect a relay; only the SAS does).
    expect(initiator.sas[0]).toBe(mSasTowardI[0]);
    expect(responder.sas[0]).toBe(mSasTowardR[0]);

    // The user rejects on mismatch → nothing is persisted anywhere.
    initiator.pairing.reject();
    responder.pairing.reject();
    await flush();
    expect(initiator.peers.list()).toHaveLength(0);
    expect(responder.peers.list()).toHaveLength(0);
    expect(initiator.pins.list()).toHaveLength(0);
    expect(responder.pins.list()).toHaveLength(0);
    expect(initiator.secrets.exportAll()).toEqual({});
    expect(responder.secrets.exportAll()).toEqual({});
  });

  it('commit-then-reveal: the attacker must commit before seeing the peer reveal (cannot grind)', async () => {
    // Assert the ordering that makes the SAS-divergence unavoidable: on each leg,
    // the attacker's commit frame is observed BEFORE the victim's reveal frame.
    const clock = () => 1000;
    const wireI = new Wire();
    const initiator = makeSide('initiator', wireI, clock);

    const mWireTowardI = new Wire();
    const mAsResponder = new PeerPairing({
      role: 'responder',
      sessionId: SESSION_ID,
      channel: mWireTowardI,
      now: clock,
      pinnedCertStore: new PinnedCertStore(),
      secretStore: new SecretStore(),
      peerConfigManager: new PeerConfigManager(undefined, clock),
      self: { machineId: R.machineId, certFp: R.certFp },
      peer: { machineId: I.machineId, certFp: I.certFp, alias: 'alias-I', address: '10.0.0.1:47474' },
    });

    const order: string[] = [];
    wireI.peer = mAsResponder;
    mWireTowardI.peer = initiator.pairing;
    // Record the frame order as seen on the wire between I and M.
    wireI.intercept = (m) => { order.push(`I→M:${m.step}`); return m; };
    mWireTowardI.intercept = (m) => { order.push(`M→I:${m.step}`); return m; };

    initiator.pairing.begin();
    await flush();

    // M's own commit (M→I:commit) precedes I's reveal (I→M:reveal): M is bound to
    // its ephemeral key before it can learn I's, so it cannot align the two SAS.
    const mCommitIdx = order.indexOf('M→I:commit');
    const iRevealIdx = order.indexOf('I→M:reveal');
    expect(mCommitIdx).toBeGreaterThanOrEqual(0);
    expect(iRevealIdx).toBeGreaterThanOrEqual(0);
    expect(mCommitIdx).toBeLessThan(iRevealIdx);
  });
});

describe('PeerPairing idempotency', () => {
  it('pairing an already-known peer (same machineId) UPDATES rather than duplicates', async () => {
    const clock = () => 1000;
    const { initiator, responder } = pair(clock);
    // Pre-seed the initiator with an existing peer for R's machineId.
    initiator.peers.upsertByMachineId({
      machineId: R.machineId, alias: 'old-alias', address: 'old:1', pskRef: 'old-ref', inbound: true,
    });
    expect(initiator.peers.list()).toHaveLength(1);

    initiator.pairing.begin();
    await flush();
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();

    // Still exactly one peer for that machineId — updated, not duplicated.
    expect(initiator.peers.list()).toHaveLength(1);
    expect(initiator.peers.getByMachineId(R.machineId)).toBeDefined();
  });

  it('is idempotent to a second accept() (no double-persist / no throw)', async () => {
    const { initiator, responder } = pair();
    initiator.pairing.begin();
    await flush();
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();
    // A stray second accept must be ignored.
    expect(() => initiator.pairing.accept()).not.toThrow();
    expect(initiator.paired).toHaveLength(1);
    expect(initiator.peers.list()).toHaveLength(1);
  });
});

describe('PeerPairing rollback on partial persist failure', () => {
  it('SecretStore.set throwing → no usable PeerConfig / pin remains', async () => {
    const { initiator, responder } = pair();
    // Make the initiator's SecretStore.set throw AFTER pin+config might be written.
    const realSet = initiator.secrets.set.bind(initiator.secrets);
    let calls = 0;
    initiator.secrets.set = ((ref: string, buf: Buffer) => {
      calls++;
      throw new Error('disk full');
    }) as any;

    initiator.pairing.begin();
    await flush();
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();

    expect(calls).toBeGreaterThan(0);
    // Rollback: nothing usable left on the initiator.
    expect(initiator.peers.list()).toHaveLength(0);
    expect(initiator.pins.list()).toHaveLength(0);
    expect(initiator.secrets.exportAll()).toEqual({});
    expect(initiator.paired).toHaveLength(0);
    expect(initiator.failed.length).toBeGreaterThan(0);
    void realSet;
  });

  it('re-pair persist failure restores the pre-existing peer (no corrupted config)', async () => {
    const { initiator, responder } = pair();
    // Pre-existing peer for R with its own alias/pskRef/allow.
    initiator.peers.upsertByMachineId({
      machineId: R.machineId, alias: 'original', address: 'orig:1', pskRef: 'orig-ref', inbound: true,
    });
    initiator.secrets.set('orig-ref', Buffer.alloc(32, 0xaa));

    // Fail the NEW secret write on finalize.
    initiator.secrets.set = ((ref: string) => {
      if (ref !== 'orig-ref') throw new Error('disk full');
    }) as any;

    initiator.pairing.begin();
    await flush();
    initiator.pairing.accept();
    responder.pairing.accept();
    await flush();

    // Still exactly one peer, restored to its ORIGINAL fields (not the new ones).
    const peer = initiator.peers.getByMachineId(R.machineId)!;
    expect(initiator.peers.list()).toHaveLength(1);
    expect(peer.alias).toBe('original');
    expect(peer.pskRef).toBe('orig-ref');
    expect(peer.inbound).toBe(true);
    expect(initiator.paired).toHaveLength(0);
  });
});
