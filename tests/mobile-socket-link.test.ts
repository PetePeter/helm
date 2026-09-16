/**
 * SocketLinkTransport — the LAN half of the phone link (P-0752 phase 2).
 *
 * Driven against REAL loopback sockets and a REAL SecureChannel on both ends.
 * The point of this file is that the pipe abstraction has not leaked: the same
 * crypto, the same PSK, the same vocabulary as BLE, over a socket. Nothing here
 * mocks a socket — if it needed a mock the abstraction would already be wrong.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { SocketLinkTransport } from '../src/mobile/lan/socket-link-transport.js';
import { SecureChannel } from '../src/mobile/secure-channel.js';
import { RANK_LAN, type MobileLink } from '../src/mobile/mobile-link.js';

const PHONE = 'phone-machine-1';
const PSK = Buffer.alloc(32, 0x4d);

/** Every socket and transport a test opened, torn down whatever happens. */
const open: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

/** A transport on an ephemeral port, so tests never collide on a fixed one. */
async function startTransport(options: { logger?: (m: string) => void } = {}) {
  const links: MobileLink[] = [];
  const disconnected: string[] = [];
  const transport = new SocketLinkTransport({ port: 0, logger: options.logger });
  transport.on('link', (link: MobileLink) => links.push(link));
  transport.on('disconnected', (deviceId: string) => disconnected.push(deviceId));
  await transport.start();
  open.push({ close: () => transport.stop() });
  return { transport, links, disconnected, port: transport.boundPort! };
}

/** Dial the transport as a phone would, and wait for the link to surface. */
async function dial(port: number, links: MobileLink[]): Promise<Socket> {
  const socket = connect({ port, host: '127.0.0.1' });
  open.push({ close: () => void socket.destroy() });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  await waitFor(() => links.length > 0);
  return socket;
}

/** Poll a condition without inventing a fixed sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A BytePipe over a raw client socket — the phone's end, written by hand. */
function phonePipe(socket: Socket) {
  return {
    write: (data: Buffer) => { socket.write(data); },
    onData: (handler: (chunk: Buffer) => void) => { socket.on('data', handler); },
    onClose: (handler: () => void) => { socket.on('close', handler); },
    close: () => { socket.destroy(); },
  };
}

describe('SocketLinkTransport', () => {
  it('declares the LAN rank, so the manager displaces BLE with it', () => {
    expect(new SocketLinkTransport({ port: 0 }).rank).toBe(RANK_LAN);
  });

  it('surfaces each accepted connection as a MobileLink naming its peer', async () => {
    const { links, port } = await startTransport();
    await dial(port, links);

    expect(links).toHaveLength(1);
    // The address is a connection label, never an identity — but it must at
    // least name the peer, or a log of refusals is unreadable.
    expect(links[0].deviceId).toContain('127.0.0.1');
  });

  it('does not persist its address as a reconnect hint', async () => {
    // A TCP source port is ephemeral. Writing it to MobileDevice.deviceId would
    // evict the BLE peripheral id that the BLE candidate ranking depends on —
    // so connecting once over LAN would degrade every later BLE reconnect.
    expect(new SocketLinkTransport({ port: 0 }).persistsAddressHint).toBe(false);
  });

  it('reports a disconnect when the phone goes away', async () => {
    const { links, disconnected, port } = await startTransport();
    const socket = await dial(port, links);

    socket.destroy();
    await waitFor(() => disconnected.length > 0);

    expect(disconnected).toEqual([links[0].deviceId]);
  });

  it('closes a refused link and reports it once', async () => {
    const { transport, links, disconnected, port } = await startTransport();
    const socket = await dial(port, links);

    await transport.reject(links[0], 'not a trusted device');
    await waitFor(() => socket.destroyed);

    expect(socket.destroyed).toBe(true);
    expect(disconnected).toEqual([links[0].deviceId]);
  });

  it('unbinds the port when stopped, and binds again when restarted', async () => {
    const { transport, port } = await startTransport();
    await transport.stop();

    await expect(dialRaw(port)).rejects.toThrow();

    await transport.start();
    // A fresh ephemeral port: what matters is that a stopped transport accepts
    // nothing and a restarted one does.
    await expect(dialRaw(transport.boundPort!)).resolves.toBeDefined();
  });
});

/** Dial without expecting a link — used to prove a port is closed. */
async function dialRaw(port: number): Promise<Socket> {
  const socket = connect({ port, host: '127.0.0.1' });
  open.push({ close: () => void socket.destroy() });
  return new Promise<Socket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('SocketLinkTransport configuration', () => {
  it('binds nothing at all while disabled', async () => {
    const transport = new SocketLinkTransport({ port: 0, enabled: false });
    open.push({ close: () => transport.stop() });
    await transport.start();

    expect(transport.boundPort).toBeNull();
  });

  it('binds when enabled live, and unbinds when disabled live', async () => {
    // The user toggles the setting; nothing restarts. Both directions have to
    // work, or "disable" becomes a lie until the next launch.
    const transport = new SocketLinkTransport({ port: 0, enabled: false });
    open.push({ close: () => transport.stop() });
    await transport.start();

    await transport.configure({ enabled: true, port: 0 });
    expect(transport.boundPort).toBeGreaterThan(0);

    await transport.configure({ enabled: false, port: 0 });
    expect(transport.boundPort).toBeNull();
  });

  it('does not bind on a config change the manager never asked to run', async () => {
    // Enabling LAN must not by itself open a port: the radio rule holds for the
    // socket too — nothing binds on a machine with no paired phone.
    const transport = new SocketLinkTransport({ port: 0, enabled: false });
    open.push({ close: () => transport.stop() });

    await transport.configure({ enabled: true, port: 0 });

    expect(transport.boundPort).toBeNull();
  });

  it('drops live connections when disabled', async () => {
    const { transport, links, port } = await startTransport();
    const socket = await dial(port, links);

    await transport.configure({ enabled: false, port });
    await waitFor(() => socket.destroyed);

    expect(transport.boundPort).toBeNull();
  });
});

describe('SocketLinkTransport carries a real SecureChannel', () => {
  it('completes a handshake with a stored PSK and raises NO SAS prompt', async () => {
    // The whole justification for this plan: the crypto lane is transport
    // agnostic, so a socket needs no new handshake and no new vectors.
    const { links, port } = await startTransport();
    const socket = await dial(port, links);

    const phone = SecureChannel.open({
      pipe: phonePipe(socket), role: 'responder', machineId: PHONE, psk: PSK,
    });
    const helm = await SecureChannel.open({
      pipe: links[0].pipe, role: 'initiator', machineId: 'desktop',
      sessionId: 'lan-test', psk: PSK,
    });
    const phoneChannel = await phone;

    expect(phoneChannel.sasConfirmationRequired).toBe(false);
    expect(helm.peerMachine).toBe(PHONE);
  });

  it('round-trips a payload far larger than any BLE frame', async () => {
    // TCP delivers an arbitrarily segmented stream. SecureChannel's own
    // length-prefix framing has to reassemble it — if the socket pipe needed a
    // chunker of its own, the BLE framing would have leaked into the contract.
    //
    // 100 KiB sits under SecureChannel's 128 KiB MAX_FRAME_BYTES, which is an
    // APPLICATION ceiling and applies to BLE identically: a faster pipe does not
    // buy a bigger frame. It is ~5000 BLE chunks all the same.
    const { links, port } = await startTransport();
    const socket = await dial(port, links);
    const phone = SecureChannel.open({
      pipe: phonePipe(socket), role: 'responder', machineId: PHONE, psk: PSK,
    });
    const helm = await SecureChannel.open({
      pipe: links[0].pipe, role: 'initiator', machineId: 'desktop',
      sessionId: 'lan-test', psk: PSK,
    });
    const phoneChannel = await phone;

    const payload = Buffer.alloc(100 * 1024, 0xab);
    const arrived = new Promise<Buffer>((resolve) => phoneChannel.once('message', resolve));
    helm.send(payload);

    expect(Buffer.compare(await arrived, payload)).toBe(0);
  });

  it('refuses a peer offering the wrong PSK', async () => {
    const { links, port } = await startTransport();
    const socket = await dial(port, links);

    const phone = expect(SecureChannel.open({
      pipe: phonePipe(socket), role: 'responder', machineId: PHONE,
      psk: Buffer.alloc(32, 0x99),
    })).rejects.toThrow();
    const helm = expect(SecureChannel.open({
      pipe: links[0].pipe, role: 'initiator', machineId: 'desktop',
      sessionId: 'lan-test', psk: PSK,
    })).rejects.toThrow();

    await Promise.all([helm, phone]);
  });

  it('closes on garbage without allocating a channel', async () => {
    // A LAN port gets scanned. Nonsense must cost a bounded, tiny amount: the
    // frame-length guard rejects it before any allocation is made on its behalf.
    const { links, port } = await startTransport();
    const socket = await dial(port, links);
    const helm = SecureChannel.open({
      pipe: links[0].pipe, role: 'initiator', machineId: 'desktop',
      sessionId: 'lan-test', psk: PSK,
    });

    const garbage = Buffer.alloc(64);
    garbage.writeUInt32BE(0xfffffff, 0);
    socket.write(garbage);

    await expect(helm).rejects.toThrow();
  });
});
