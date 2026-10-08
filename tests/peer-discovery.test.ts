/**
 * PeerDiscovery unit tests — a FAKE bonjour backend (no real mDNS/network).
 *
 * The backend factory is injected, so we drive service 'up'/'down' events by
 * hand and assert the discovery layer's parsing + self-filtering + lifecycle.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { PeerDiscovery, HELM_SERVICE_TYPE } from '../src/mcp/peer/peer-discovery.js';

/** A minimal fake mirroring the bonjour-service Browser/Service/Bonjour surface. */
class FakeBrowser extends EventEmitter {
  started = false;
  stopped = false;
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

class FakeBonjour {
  published: any[] = [];
  browsers: FakeBrowser[] = [];
  unpublishedAll = false;
  destroyed = false;

  publish(opts: any): any {
    const service = { ...opts, start: vi.fn(), stop: vi.fn() };
    this.published.push(service);
    return service;
  }
  find(_opts: any): FakeBrowser {
    const b = new FakeBrowser();
    this.browsers.push(b);
    return b;
  }
  unpublishAll(cb?: () => void): void { this.unpublishedAll = true; cb?.(); }
  destroy(cb?: () => void): void { this.destroyed = true; cb?.(); }
}

function makeService(machineId: string, alias: string, host = '10.0.0.9', port = 47474) {
  return {
    name: `helm-${machineId}`,
    txt: { machineId, alias },
    host,
    port,
    addresses: [host],
    referer: { address: host, family: 'IPv4', port },
  };
}

function setup(ownMachineId = 'me') {
  const backend = new FakeBonjour();
  const discovery = new PeerDiscovery({
    machineId: ownMachineId,
    createBackend: () => backend as any,
  });
  return { backend, discovery };
}

describe('PeerDiscovery.advertise', () => {
  it('publishes the _helm._tcp service with machineId+alias TXT', () => {
    const { backend, discovery } = setup();
    discovery.start();
    discovery.advertise({ machineId: 'me', alias: 'This Mac', port: 47474 });

    expect(backend.published).toHaveLength(1);
    const svc = backend.published[0];
    expect(svc.type).toBe(HELM_SERVICE_TYPE);
    expect(svc.port).toBe(47474);
    expect(svc.txt).toMatchObject({ machineId: 'me', alias: 'This Mac' });
  });
});

describe('PeerDiscovery browse', () => {
  it('emits peer-discovered with parsed machineId/alias/address on a service "up"', () => {
    const { backend, discovery } = setup('me');
    const seen: any[] = [];
    discovery.on('peer-discovered', (p) => seen.push(p));
    discovery.start();

    const browser = backend.browsers[0];
    browser.emit('up', makeService('peer-1', 'The Laptop', '10.0.0.9', 47474));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      machineId: 'peer-1',
      alias: 'The Laptop',
      address: '10.0.0.9:47474',
      addresses: ['10.0.0.9:47474'],
    });
  });

  // A multi-homed peer advertises every adapter; only some are routable from here.
  it('keeps every IPv4 address of a multi-homed peer, the one it reached us on first', () => {
    const { backend, discovery } = setup('me');
    const seen: any[] = [];
    discovery.on('peer-discovered', (p) => seen.push(p));
    discovery.start();

    backend.browsers[0].emit('up', {
      ...makeService('peer-1', 'Tower'),
      addresses: ['172.23.128.1', 'fe80::1c2d:3e4f', '192.168.1.20', '10.0.0.9'],
      referer: { address: '192.168.1.20', family: 'IPv4', port: 5353 },
    });

    expect(seen[0].addresses).toEqual(['192.168.1.20:47474', '172.23.128.1:47474', '10.0.0.9:47474']);
    expect(seen[0].address).toBe('192.168.1.20:47474');
  });

  it('falls back to the mDNS hostname when no IPv4 address is advertised', () => {
    const { backend, discovery } = setup('me');
    const seen: any[] = [];
    discovery.on('peer-discovered', (p) => seen.push(p));
    discovery.start();

    backend.browsers[0].emit('up', {
      ...makeService('peer-1', 'Tower', 'tower.local'),
      addresses: ['fe80::1'],
      referer: { address: 'fe80::1', family: 'IPv6', port: 5353 },
    });

    expect(seen[0].addresses).toEqual(['tower.local:47474']);
  });

  it('IGNORES our own advertised service (no self-pairing)', () => {
    const { backend, discovery } = setup('me');
    const seen: any[] = [];
    discovery.on('peer-discovered', (p) => seen.push(p));
    discovery.start();

    backend.browsers[0].emit('up', makeService('me', 'This Mac'));
    expect(seen).toHaveLength(0);
  });

  it('drops a service missing a machineId TXT', () => {
    const { backend, discovery } = setup('me');
    const seen: any[] = [];
    discovery.on('peer-discovered', (p) => seen.push(p));
    discovery.start();

    backend.browsers[0].emit('up', { txt: { alias: 'x' }, host: 'h', port: 1 });
    expect(seen).toHaveLength(0);
  });

  it('emits peer-lost with the machineId on a service "down"', () => {
    const { backend, discovery } = setup('me');
    const lost: any[] = [];
    discovery.on('peer-lost', (p) => lost.push(p));
    discovery.start();

    backend.browsers[0].emit('down', makeService('peer-1', 'The Laptop'));
    expect(lost).toEqual([{ machineId: 'peer-1' }]);
  });

  it('does not emit peer-lost for our own service going down', () => {
    const { backend, discovery } = setup('me');
    const lost: any[] = [];
    discovery.on('peer-lost', (p) => lost.push(p));
    discovery.start();

    backend.browsers[0].emit('down', makeService('me', 'This Mac'));
    expect(lost).toHaveLength(0);
  });
});

describe('PeerDiscovery lifecycle', () => {
  it('start creates a browser and starts it; stop tears the backend down', () => {
    const { backend, discovery } = setup();
    discovery.start();
    expect(backend.browsers).toHaveLength(1);
    expect(backend.browsers[0].started).toBe(true);

    discovery.stop();
    expect(backend.destroyed).toBe(true);
  });

  it('start is idempotent (a second start does not spawn a second backend)', () => {
    const { backend, discovery } = setup();
    discovery.start();
    discovery.start();
    // Only one browser from the single backend.
    expect(backend.browsers).toHaveLength(1);
  });
});
