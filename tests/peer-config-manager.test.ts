/**
 * PeerConfigManager unit tests — real class, fake injected persist callback +
 * injected clock. No mock/verify theatre: assertions read observable state via
 * the public API. Persistence layer covered against a real OS temp file.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { PeerConfigManager } from '../src/session/peer-config-manager.js';
import { sanitizePeers } from '../src/session/peer-sanitize.js';
import type { PeerConfig } from '../src/types/peer.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const baseInput = () => ({
  alias: 'the Mac',
  address: '192.168.1.5:9443',
  pskRef: 'secret-store://peer/mac',
});

describe('PeerConfigManager', () => {
  it('P1 add→list round-trips and stores defaults', () => {
    const mgr = new PeerConfigManager();
    const peer = mgr.add(baseInput());

    expect(peer.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(peer.alias).toBe('the Mac');
    expect(peer.address).toBe('192.168.1.5:9443');
    expect(peer.pskRef).toBe('secret-store://peer/mac');
    expect(peer.inbound).toBe(false);          // default
    expect(peer.direction).toBe('bidirectional'); // default

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(peer.id);
  });

  it('P2 get by id and by alias', () => {
    const mgr = new PeerConfigManager();
    const peer = mgr.add(baseInput());

    expect(mgr.get(peer.id)!.id).toBe(peer.id);
    expect(mgr.getByAlias('the Mac')!.id).toBe(peer.id);
    expect(mgr.get('nope')).toBeUndefined();
    expect(mgr.getByAlias('nope')).toBeUndefined();
  });

  it('P3 update merges, re-persists, returns copy; unknown id → undefined', () => {
    const persist = vi.fn();
    const mgr = new PeerConfigManager(persist);
    const peer = mgr.add(baseInput());
    expect(persist).toHaveBeenCalledTimes(1);

    const updated = mgr.update(peer.id, { alias: 'renamed', inbound: true });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(updated!.alias).toBe('renamed');
    expect(updated!.inbound).toBe(true);
    // id/createdAt untouched
    expect(updated!.id).toBe(peer.id);
    expect(updated!.createdAt).toBe(peer.createdAt);

    expect(mgr.update('nope', { alias: 'x' })).toBeUndefined();
  });

  it('P3b update guards direction: an invalid value leaves the stored direction unchanged', () => {
    const mgr = new PeerConfigManager();
    const peer = mgr.add({ ...baseInput(), direction: 'inbound' });

    const updated = mgr.update(peer.id, {
      alias: 'still-updates',
      direction: 'sideways' as unknown as PeerConfig['direction'],
    });

    expect(updated!.direction).toBe('inbound'); // rejected invalid direction
    expect(updated!.alias).toBe('still-updates'); // other fields still merge
    expect(mgr.get(peer.id)!.direction).toBe('inbound');
  });

  it('P4 remove deletes + returns true; unknown → false', () => {
    const persist = vi.fn();
    const mgr = new PeerConfigManager(persist);
    const peer = mgr.add(baseInput());
    persist.mockClear();

    expect(mgr.remove(peer.id)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(mgr.list()).toHaveLength(0);

    expect(mgr.remove('nope')).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1); // unchanged
  });

  it('P5 emits peer-config:changed on each mutation', () => {
    const mgr = new PeerConfigManager();
    const events: number[] = [];
    mgr.on('peer-config:changed', () => events.push(1));

    const peer = mgr.add(baseInput());
    mgr.update(peer.id, { alias: 'x' });
    mgr.remove(peer.id);

    expect(events).toHaveLength(3);
  });

  it('P6 injected clock stamps createdAt deterministically', () => {
    let t = 4242;
    const mgr = new PeerConfigManager(undefined, () => t);
    const peer = mgr.add(baseInput());
    expect(peer.createdAt).toBe(4242);
  });

  describe('isInboundAllowed', () => {
    it('A1 inbound:true lets the peer call me', () => {
      const mgr = new PeerConfigManager();
      const p = mgr.add({ ...baseInput(), inbound: true });
      expect(mgr.isInboundAllowed(p.id)).toBe(true);
    });

    it('A2 inbound:false (the default) blocks the peer', () => {
      const mgr = new PeerConfigManager();
      const p = mgr.add(baseInput());
      expect(mgr.isInboundAllowed(p.id)).toBe(false);
    });

    it('A3 unknown peer → false', () => {
      const mgr = new PeerConfigManager();
      expect(mgr.isInboundAllowed('nope')).toBe(false);
    });
  });

  describe('peerAllowsMe (the peer-reported half)', () => {
    it('R1 setPeerAllowsMe records the peer report and persists it', () => {
      const persist = vi.fn();
      const mgr = new PeerConfigManager(persist);
      const p = mgr.add(baseInput());
      persist.mockClear();
      mgr.setPeerAllowsMe(p.id, true);
      expect(mgr.get(p.id)!.peerAllowsMe).toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('R2 an unchanged report does not re-persist', () => {
      const persist = vi.fn();
      const mgr = new PeerConfigManager(persist);
      const p = mgr.add(baseInput());
      mgr.setPeerAllowsMe(p.id, true);
      persist.mockClear();
      mgr.setPeerAllowsMe(p.id, true);
      expect(persist).not.toHaveBeenCalled();
    });

    it('R3 a report never changes my own inbound grant', () => {
      const mgr = new PeerConfigManager();
      const p = mgr.add(baseInput());
      mgr.setPeerAllowsMe(p.id, true);
      expect(mgr.isInboundAllowed(p.id)).toBe(false);
    });
  });

  it('P9 importAll(exportAll()) round-trips and sanitizes garbage', () => {
    const mgr = new PeerConfigManager();
    mgr.add({ ...baseInput(), inbound: true });
    const snapshot = mgr.exportAll();

    const mgr2 = new PeerConfigManager();
    mgr2.importAll([
      ...snapshot,
      { garbage: true } as unknown as PeerConfig,
      { id: 'x', alias: 'y', address: 'z', direction: 'weird' } as unknown as PeerConfig,
    ]);

    const list = mgr2.list();
    expect(list).toHaveLength(1);
    expect(list[0].alias).toBe('the Mac');
    expect(list[0].inbound).toBe(true);
  });

  describe('migration from the per-tool allow-list', () => {
    const legacy = (allow: unknown) => ({
      id: 'g1', alias: 'a', address: 'h:1', pskRef: 'r', direction: 'bidirectional', allow,
    }) as unknown as PeerConfig;

    it('G1 a non-empty legacy allow-list becomes inbound:true', () => {
      expect(sanitizePeers([legacy(['session_list'])])[0].inbound).toBe(true);
    });

    it('G2 an empty or missing legacy allow-list becomes inbound:false', () => {
      expect(sanitizePeers([legacy([])])[0].inbound).toBe(false);
      expect(sanitizePeers([legacy(undefined)])[0].inbound).toBe(false);
    });

    it('G3 an explicit inbound wins over a stale allow-list and the legacy field is dropped', () => {
      const [peer] = sanitizePeers([{ ...legacy(['*']), inbound: false }]);
      expect(peer.inbound).toBe(false);
      expect('allow' in peer).toBe(false);
    });

    it('G4 migrating twice is stable', () => {
      const once = sanitizePeers([legacy(['*'])]);
      expect(sanitizePeers(once)).toEqual(once);
    });
  });

  describe('machineId lookup + upsert (pairing idempotency)', () => {
    it('M1 add carries machineId and getByMachineId finds it', () => {
      const mgr = new PeerConfigManager();
      const peer = mgr.add({ ...baseInput(), machineId: 'mac-123' });
      expect(peer.machineId).toBe('mac-123');
      expect(mgr.getByMachineId('mac-123')!.id).toBe(peer.id);
      expect(mgr.getByMachineId('nope')).toBeUndefined();
    });

    it('M2 upsertByMachineId inserts when the machineId is new', () => {
      const mgr = new PeerConfigManager();
      const peer = mgr.upsertByMachineId({
        machineId: 'mac-123', alias: 'a', address: 'h:1', pskRef: 'r', inbound: true,
      });
      expect(mgr.list()).toHaveLength(1);
      expect(peer.machineId).toBe('mac-123');
      expect(peer.inbound).toBe(true);
    });

    it('M3 upsertByMachineId UPDATES the existing peer (no duplicate)', () => {
      const mgr = new PeerConfigManager();
      const first = mgr.upsertByMachineId({
        machineId: 'mac-123', alias: 'old', address: 'h:1', pskRef: 'r1', inbound: false,
      });
      const second = mgr.upsertByMachineId({
        machineId: 'mac-123', alias: 'new', address: 'h:2', pskRef: 'r2', inbound: true,
      });

      expect(mgr.list()).toHaveLength(1);        // no duplicate
      expect(second.id).toBe(first.id);          // same identity preserved
      expect(second.alias).toBe('new');
      expect(second.address).toBe('h:2');
      expect(second.pskRef).toBe('r2');
      expect(second.inbound).toBe(true);
    });

    it('M4 upsertByMachineId preserves createdAt on update', () => {
      let t = 100;
      const mgr = new PeerConfigManager(undefined, () => t);
      const first = mgr.upsertByMachineId({ machineId: 'm', alias: 'a', address: 'h:1', pskRef: 'r' });
      t = 999;
      const second = mgr.upsertByMachineId({ machineId: 'm', alias: 'b', address: 'h:1', pskRef: 'r' });
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.createdAt).toBe(100);
    });

    it('M5 importAll preserves a machineId', () => {
      const mgr = new PeerConfigManager();
      mgr.importAll([{
        id: 'p1', alias: 'a', address: 'h:1', pskRef: 'r',
        inbound: false, direction: 'bidirectional', createdAt: 1, machineId: 'mac-9',
      }]);
      expect(mgr.getByMachineId('mac-9')!.id).toBe('p1');
    });
  });

  describe('enabled field (default-true toggle)', () => {
    it('E1 add omits enabled by default (undefined = enabled)', () => {
      const mgr = new PeerConfigManager();
      const peer = mgr.add(baseInput());
      expect(peer.enabled).toBeUndefined();
    });

    it('E2 add can set enabled:false and it round-trips', () => {
      const mgr = new PeerConfigManager();
      const peer = mgr.add({ ...baseInput(), enabled: false });
      expect(peer.enabled).toBe(false);
      expect(mgr.get(peer.id)!.enabled).toBe(false);
    });

    it('E3 update toggles enabled and re-persists', () => {
      const persist = vi.fn();
      const mgr = new PeerConfigManager(persist);
      const peer = mgr.add(baseInput());
      persist.mockClear();

      const off = mgr.update(peer.id, { enabled: false });
      expect(off!.enabled).toBe(false);
      expect(persist).toHaveBeenCalledTimes(1);

      const on = mgr.update(peer.id, { enabled: true });
      expect(on!.enabled).toBe(true);
    });

    it('E4 importAll preserves an explicit enabled:false', () => {
      const mgr = new PeerConfigManager();
      mgr.importAll([{
        id: 'p1', alias: 'a', address: 'h:1', pskRef: 'r',
        inbound: false, direction: 'bidirectional', createdAt: 1, enabled: false,
      }]);
      expect(mgr.get('p1')!.enabled).toBe(false);
    });

    it('E5 importAll drops a non-boolean enabled (stays undefined)', () => {
      const mgr = new PeerConfigManager();
      mgr.importAll([{
        id: 'p1', alias: 'a', address: 'h:1', pskRef: 'r',
        inbound: false, direction: 'bidirectional', createdAt: 1,
        enabled: 'yes' as unknown as boolean,
      }]);
      expect(mgr.get('p1')!.enabled).toBeUndefined();
    });
  });
});

describe('peer-config-persistence (real temp-file round trip)', () => {
  it('save then load preserves machineId and enabled through the real loader guards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-peers-'));
    const file = join(dir, 'peers.yaml');
    try {
      const peers: PeerConfig[] = [{
        id: 'p1', alias: 'the Mac', address: 'h:1', pskRef: 'ref',
        inbound: true, direction: 'bidirectional', createdAt: 100,
        machineId: 'MID-REMOTE', enabled: false,
      }];
      // Write the exact YAML shape savePeers uses, then read it back through the
      // loader's OWN sanitizer. Asserting only the YAML round-trip (as this test
      // once did) cannot see the loader silently dropping a field: it dropped
      // machineId, so after a restart a paired peer could no longer be found by
      // machineId and re-pairing forked a duplicate entry with orphaned secrets.
      writeFileSync(file, YAML.stringify({ peers }), 'utf8');
      const parsed = YAML.parse(readFileSync(file, 'utf8')) as unknown;
      expect(sanitizePeers((parsed as { peers: unknown[] }).peers)).toEqual(peers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed YAML parses to a non-record → empty via manager importAll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-peers-'));
    const file = join(dir, 'peers.yaml');
    try {
      writeFileSync(file, 'this: [is, not, {peers}\n', 'utf8');
      let parsed: unknown = null;
      try {
        parsed = YAML.parse(readFileSync(file, 'utf8'));
      } catch {
        parsed = null;
      }
      const arr = (parsed && typeof parsed === 'object' && Array.isArray((parsed as { peers?: unknown }).peers))
        ? (parsed as { peers: PeerConfig[] }).peers
        : [];
      const mgr = new PeerConfigManager();
      mgr.importAll(arr);
      expect(mgr.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
