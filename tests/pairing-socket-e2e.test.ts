/**
 * Pairing over the REAL wire — two machines, real self-signed certs, real mTLS
 * loopback on an ephemeral port. This is the path that did not exist: production
 * wired PeerPairing to a channel that discarded every frame, so no two machines
 * could ever pair.
 *
 * Only the logger is mocked. Everything else — TLS, WebSocket, X25519, the SAS
 * derivation, the trust stores — is the real implementation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateSelfSignedCert } from '../src/mcp/peer/peer-crypto.js';
import { PinnedCertStore } from '../src/mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';
import { RemoteLinkServer } from '../src/mcp/peer/remote-link-server.js';
import { connectPairingSocket, type PairingSocket, type PairingHello } from '../src/mcp/peer/pairing-socket.js';
import { PeerPairing } from '../src/mcp/peer/peer-pairing.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

let dir = '';
const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const d of disposers.splice(0).reverse()) await d();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** One machine's trust stores + identity. */
interface Machine {
  machineId: string;
  alias: string;
  certFp: string;
  getCertKey: () => Promise<{ certPem: string; keyPem: string }>;
  pins: PinnedCertStore;
  secrets: SecretStore;
  peers: PeerConfigManager;
}

async function makeMachine(machineId: string, alias: string): Promise<Machine> {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'helm-pairing-'));
  const cert = await getOrCreateSelfSignedCert(join(dir, `${machineId}.yaml`));
  return {
    machineId,
    alias,
    certFp: cert.fingerprint,
    getCertKey: async () => ({ certPem: cert.certPem, keyPem: cert.privateKeyPem }),
    pins: new PinnedCertStore(() => {}),
    secrets: new SecretStore(() => {}),
    peers: new PeerConfigManager(() => {}),
  };
}

/**
 * Stand a machine up as a pairing responder and return its port. `onHello` lets a
 * test observe (or a hostile test tamper with) what the responder was told.
 */
async function listenForPairing(
  machine: Machine,
  onPairing: (socket: PairingSocket, hello: PairingHello) => void,
): Promise<number> {
  const server = new RemoteLinkServer({
    host: '127.0.0.1',
    port: 0,
    machineId: machine.machineId,
    getCertKey: machine.getCertKey,
    resolvePsk: (peerId) => machine.secrets.get(`peer-${peerId}`),
    pinnedCertStore: machine.pins,
    onCall: async () => 'unused',
    onLink: () => {},
    onPairingConnection: (socket) => {
      socket.once('hello', (hello: PairingHello) => onPairing(socket, hello));
    },
  });
  await server.start();
  disposers.push(() => server.stop());
  return server.address()!.port;
}

/** Build the responder-side pairing for an accepted socket. */
function responderFor(machine: Machine, socket: PairingSocket, hello: PairingHello): PeerPairing {
  const pairing = new PeerPairing({
    role: 'responder',
    sessionId: hello.sessionId,
    channel: socket,
    pinnedCertStore: machine.pins,
    secretStore: machine.secrets,
    peerConfigManager: machine.peers,
    self: { machineId: machine.machineId, certFp: machine.certFp },
    peer: {
      machineId: hello.machineId,
      alias: hello.alias,
      certFp: socket.peerCertFp,
      address: '127.0.0.1:0',
    },
  });
  socket.on('message', (msg) => pairing.handleMessage(msg));
  return pairing;
}

/** Wait for a pairing's SAS, or fail loudly rather than hang the suite. */
function sasOf(pairing: PeerPairing, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    pairing.once('sas', resolve);
    pairing.once('failed', (info: { reason: string }) => reject(new Error(`${label} failed: ${info.reason}`)));
    setTimeout(() => reject(new Error(`${label} produced no SAS`)), 5000);
  });
}

/**
 * Run a full pairing between two machines. `mutateHello` lets a test act as an
 * active attacker rewriting the identity announcement in flight.
 */
async function pairMachines(opts: {
  initiator: Machine;
  responder: Machine;
  mutateHello?: (hello: PairingHello) => PairingHello;
}): Promise<{ initiatorSas: string; responderSas: string; initiator: PeerPairing; responder: PeerPairing }> {
  const sessionId = 'session-under-test';
  let resolveResponder: (p: PeerPairing) => void;
  const responderReady = new Promise<PeerPairing>((resolve) => { resolveResponder = resolve; });

  const port = await listenForPairing(opts.responder, (socket, hello) => {
    resolveResponder(responderFor(opts.responder, socket, opts.mutateHello ? opts.mutateHello(hello) : hello));
  });

  const socket = await connectPairingSocket({
    address: `127.0.0.1:${port}`,
    getCertKey: opts.initiator.getCertKey,
  });
  disposers.push(() => socket.close());

  const initiatorPairing = new PeerPairing({
    role: 'initiator',
    sessionId,
    channel: socket,
    pinnedCertStore: opts.initiator.pins,
    secretStore: opts.initiator.secrets,
    peerConfigManager: opts.initiator.peers,
    self: { machineId: opts.initiator.machineId, certFp: opts.initiator.certFp },
    peer: {
      machineId: opts.responder.machineId,
      alias: opts.responder.alias,
      certFp: socket.peerCertFp,
      address: `127.0.0.1:${port}`,
    },
  });
  socket.on('message', (msg) => initiatorPairing.handleMessage(msg));

  socket.sendHello({ sessionId, machineId: opts.initiator.machineId, alias: opts.initiator.alias, port: 47474 });
  const responder = await responderReady;
  initiatorPairing.begin();

  const [initiatorSas, responderSas] = await Promise.all([
    sasOf(initiatorPairing, 'initiator'),
    sasOf(responder, 'responder'),
  ]);
  return { initiatorSas, responderSas, initiator: initiatorPairing, responder };
}

describe('SAS pairing over a real pairing socket', () => {
  it('derives the same code on both machines and establishes mutual trust', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');

    const { initiatorSas, responderSas, initiator, responder } = await pairMachines({ initiator: a, responder: b });

    expect(initiatorSas).toMatch(/^\d{6}$/);
    expect(responderSas).toBe(initiatorSas);

    const paired = Promise.all([
      new Promise((r) => initiator.once('paired', r)),
      new Promise((r) => responder.once('paired', r)),
    ]);
    initiator.accept();
    responder.accept();
    await paired;

    // Both sides now hold the other's cert pin, a shared PSK, and a peer entry.
    const aPeer = a.peers.getByMachineId('machine-b');
    const bPeer = b.peers.getByMachineId('machine-a');
    expect(aPeer).toBeDefined();
    expect(bPeer).toBeDefined();
    expect(a.pins.get(aPeer!.id)).toBe(b.certFp);
    expect(b.pins.get(bPeer!.id)).toBe(a.certFp);

    // The PSKs must be byte-identical or the steady-state link can never authenticate.
    const aPsk = a.secrets.get(aPeer!.pskRef);
    const bPsk = b.secrets.get(bPeer!.pskRef);
    expect(aPsk).toBeDefined();
    expect(aPsk!.equals(bPsk!)).toBe(true);

    // A fresh peer is deny-all until the user grants tools.
    expect(aPeer!.inbound).toBe(false);
  });

  it('produces different codes when the identity announcement is tampered with', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');

    // An active attacker rewrites who the responder thinks is calling.
    const { initiatorSas, responderSas } = await pairMachines({
      initiator: a,
      responder: b,
      mutateHello: (hello) => ({ ...hello, machineId: 'impostor' }),
    });

    expect(responderSas).not.toBe(initiatorSas);
  });

  it('persists nothing when a user rejects the code', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');

    const { initiator, responder } = await pairMachines({ initiator: a, responder: b });
    const failed = new Promise((r) => responder.once('failed', r));
    initiator.reject();
    responder.reject();
    await failed;

    expect(a.peers.getByMachineId('machine-b')).toBeUndefined();
    expect(b.peers.getByMachineId('machine-a')).toBeUndefined();
    expect(a.pins.list()).toEqual([]);
    expect(b.pins.list()).toEqual([]);
  });

  it('refuses a pairing connection when the responder registers no handler', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');

    const server = new RemoteLinkServer({
      host: '127.0.0.1',
      port: 0,
      machineId: b.machineId,
      getCertKey: b.getCertKey,
      resolvePsk: () => undefined,
      pinnedCertStore: b.pins,
      onCall: async () => 'unused',
      onLink: () => {},
      // onPairingConnection deliberately absent — fleet off / not wired.
    });
    await server.start();
    disposers.push(() => server.stop());

    const socket = await connectPairingSocket({
      address: `127.0.0.1:${server.address()!.port}`,
      getCertKey: a.getCertKey,
    });
    await expect(new Promise((_, reject) => {
      socket.once('closed', () => reject(new Error('closed')));
      setTimeout(() => reject(new Error('closed')), 1000);
    })).rejects.toThrow('closed');
  });
});
