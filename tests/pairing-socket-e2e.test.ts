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
import { createServer } from 'node:net';
import { getOrCreateSelfSignedCert } from '../src/mcp/peer/peer-crypto.js';
import { PinnedCertStore } from '../src/mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../src/mcp/peer/secret-store.js';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';
import { RemoteLinkServer } from '../src/mcp/peer/remote-link-server.js';
import {
  connectPairingSocket,
  bindPairingSocket,
  OutboundPairingChannel,
  type ConnectPairingSocketOptions,
  type PairingSocket,
  type PairingHello,
} from '../src/mcp/peer/pairing-socket.js';
import { PeerPairing, type PairingPeerInfo } from '../src/mcp/peer/peer-pairing.js';

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
  return listenForPairingSocket(machine, (socket) => {
    socket.once('hello', (hello: PairingHello) => onPairing(socket, hello));
  });
}

/** As listenForPairing, but hands over the raw socket before any hello. */
async function listenForPairingSocket(machine: Machine, onSocket: (socket: PairingSocket) => void): Promise<number> {
  const server = new RemoteLinkServer({
    host: '127.0.0.1',
    port: 0,
    machineId: machine.machineId,
    getCertKey: machine.getCertKey,
    resolvePsk: (peerId) => machine.secrets.get(`peer-${peerId}`),
    pinnedCertStore: machine.pins,
    onCall: async () => 'unused',
    onLink: () => {},
    onPairingConnection: onSocket,
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
  bindPairingSocket(socket, pairing);
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
  bindPairingSocket(socket, initiatorPairing);

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

/** Resolve with the reason a pairing failed, or fail loudly rather than hang. */
function failureOf(pairing: PeerPairing, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    pairing.once('failed', (info: { reason: string }) => resolve(info.reason));
    setTimeout(() => reject(new Error(`${label} never failed`)), 2000);
  });
}

// The bug: a cancel or reject stopped only the machine it was clicked on. The
// other kept its dialog and its one pairing slot until a 3-minute expiry.
describe('ending a pairing reaches the other machine', () => {
  it('initiator rejecting fails the responder at once', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');
    const { initiator, responder } = await pairMachines({ initiator: a, responder: b });

    const reason = failureOf(responder, 'responder');
    initiator.reject();

    expect(await reason).toBe('peer-disconnected');
  });

  it('responder rejecting fails the initiator at once', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');
    const { initiator, responder } = await pairMachines({ initiator: a, responder: b });

    const reason = failureOf(initiator, 'initiator');
    responder.reject();

    expect(await reason).toBe('peer-disconnected');
  });

  it('cancelling the initiator fails the responder at once', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Laptop');
    const { initiator, responder } = await pairMachines({ initiator: a, responder: b });

    const reason = failureOf(responder, 'responder');
    initiator.cancel('cancelled');

    expect(await reason).toBe('peer-disconnected');
  });
});

/** A loopback port with nothing listening — dialling it is refused immediately. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return `127.0.0.1:${port}`;
}

type Connect = (opts: ConnectPairingSocketOptions) => Promise<PairingSocket>;

/** The production initiator: an OutboundPairingChannel dialling `peer`. */
function dialOut(initiator: Machine, peer: PairingPeerInfo, connect: Connect = connectPairingSocket): PeerPairing {
  const sessionId = 'session-under-test';
  const channel = new OutboundPairingChannel({
    peer,
    sessionId,
    self: { machineId: initiator.machineId, alias: initiator.alias, port: 47474 },
    connect,
    getCertKey: initiator.getCertKey,
  });
  disposers.push(() => channel.close());
  const pairing = new PeerPairing({
    role: 'initiator',
    sessionId,
    channel,
    pinnedCertStore: initiator.pins,
    secretStore: initiator.secrets,
    peerConfigManager: initiator.peers,
    self: { machineId: initiator.machineId, certFp: initiator.certFp },
    peer,
  });
  channel.attach(pairing);
  return pairing;
}

const peerOf = (machine: Machine, addresses: string[]): PairingPeerInfo => ({
  machineId: machine.machineId,
  alias: machine.alias,
  certFp: '',
  address: addresses[0],
  candidateAddresses: addresses,
});

// The bug: a machine with two adapters advertises both, the initiator dialled
// only the first, and the pairing died whenever that one was not routable.
describe('dialling a peer with several addresses', () => {
  it('falls through a dead address to the one that answers, and pairs on it', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Tower');
    let responder!: PeerPairing;
    const port = await listenForPairing(b, (socket, hello) => { responder = responderFor(b, socket, hello); });
    const live = `127.0.0.1:${port}`;
    const peer = peerOf(b, [await deadAddress(), live]);

    const initiator = dialOut(a, peer);
    initiator.begin();
    const initiatorSas = await sasOf(initiator, 'initiator');

    expect(responder.getSas()).toBe(initiatorSas);
    // The address that answered is the one a later link must dial.
    expect(peer.address).toBe(live);
    expect(peer.certFp).toBe(b.certFp);
  });

  it('fails with connect-failed when no address answers', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Tower');

    const initiator = dialOut(a, peerOf(b, [await deadAddress(), await deadAddress()]));
    const reason = failureOf(initiator, 'initiator');
    initiator.begin();

    expect(await reason).toBe('connect-failed');
  });

  it('a cancel mid-dial stops trying the remaining addresses', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Tower');
    let reached = false;
    const port = await listenForPairing(b, () => { reached = true; });
    const dialled: string[] = [];

    const initiator: PeerPairing = dialOut(a, peerOf(b, [await deadAddress(), `127.0.0.1:${port}`]), (opts) => {
      dialled.push(opts.address);
      // Deferred: the channel dials from its constructor, before `initiator` exists.
      queueMicrotask(() => initiator.cancel('cancelled'));
      return connectPairingSocket(opts);
    });
    initiator.begin();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(dialled).toHaveLength(1);
    expect(reached).toBe(false);
  });

  it('a cancel while the dial is in flight closes the socket as soon as it opens', async () => {
    const a = await makeMachine('machine-a', 'Studio');
    const b = await makeMachine('machine-b', 'Tower');
    let helloSeen = false;
    let resolveClosed!: () => void;
    const responderClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const port = await listenForPairingSocket(b, (socket) => {
      socket.once('hello', () => { helloSeen = true; });
      socket.once('closed', resolveClosed);
    });

    const initiator: PeerPairing = dialOut(a, peerOf(b, [`127.0.0.1:${port}`]), (opts) => {
      queueMicrotask(() => initiator.cancel('cancelled'));
      return connectPairingSocket(opts);
    });

    await Promise.race([
      responderClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('responder socket was left open')), 2000)),
    ]);
    expect(helloSeen).toBe(false);
  });
});
