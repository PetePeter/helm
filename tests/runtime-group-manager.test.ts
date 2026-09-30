/**
 * RuntimeGroupManager unit tests — real class, fake injected persist callback.
 * No mock/verify theatre: assertions read observable state via the public API.
 */

import { describe, it, expect, vi } from 'vitest';
import { RuntimeGroupManager } from '../src/session/runtime-group-manager.js';
import { RUNTIME_GROUP_COLORS, type RuntimeGroup } from '../src/types/runtime-group.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('RuntimeGroupManager', () => {
  it('M1 one-group-max: adding a session to a second group evicts it from the first', () => {
    const mgr = new RuntimeGroupManager();
    const a = mgr.create('A');
    const b = mgr.create('B');

    mgr.addSession(a.id, 's1');
    mgr.addSession(b.id, 's1');

    expect(mgr.get(a.id)!.sessionIds).toEqual([]);
    expect(mgr.get(b.id)!.sessionIds).toEqual(['s1']);
    expect(mgr.groupForSession('s1')!.id).toBe(b.id);
  });

  it('M2 dedup: adding the same session twice keeps a single entry', () => {
    const mgr = new RuntimeGroupManager();
    const a = mgr.create('A');

    mgr.addSession(a.id, 's1');
    mgr.addSession(a.id, 's1');

    expect(mgr.get(a.id)!.sessionIds).toEqual(['s1']);
  });

  it('M2b idempotent order: re-adding a session to its current group preserves position and does not persist', () => {
    const persist = vi.fn();
    const mgr = new RuntimeGroupManager(persist);
    const a = mgr.create('A');       // persist #1
    mgr.addSession(a.id, 's1');       // persist #2
    mgr.addSession(a.id, 's2');       // persist #3
    expect(persist).toHaveBeenCalledTimes(3);

    // Re-adding s1 (already sole owner) must NOT move it to the end or persist.
    mgr.addSession(a.id, 's1');
    expect(mgr.get(a.id)!.sessionIds).toEqual(['s1', 's2']);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('M2c eviction preserves the target slot: moving from another group keeps existing order', () => {
    const mgr = new RuntimeGroupManager();
    const a = mgr.create('A');
    const b = mgr.create('B');
    mgr.addSession(a.id, 's1');
    mgr.addSession(a.id, 's2');
    mgr.addSession(b.id, 'sx');

    // sx already in B at index 0; add s2 (from A) to B — sx keeps its slot, s2 appends.
    mgr.addSession(b.id, 's2');
    expect(mgr.get(b.id)!.sessionIds).toEqual(['sx', 's2']);
    expect(mgr.get(a.id)!.sessionIds).toEqual(['s1']);
  });

  it('M3 removeSessionEverywhere: strips membership and is a safe no-op on repeat', () => {
    const mgr = new RuntimeGroupManager();
    const a = mgr.create('A');
    mgr.addSession(a.id, 's1');

    mgr.removeSessionEverywhere('s1');
    expect(mgr.groupForSession('s1')).toBeNull();

    // Repeat call must not throw and must not change state.
    expect(() => mgr.removeSessionEverywhere('s1')).not.toThrow();
    expect(mgr.groupForSession('s1')).toBeNull();
  });

  it('M4 closeGroup: removes the group and unclaims its members', () => {
    const mgr = new RuntimeGroupManager();
    const a = mgr.create('A');
    mgr.addSession(a.id, 's1');

    expect(mgr.closeGroup(a.id)).toBe(true);
    expect(mgr.list().find(g => g.id === a.id)).toBeUndefined();
    expect(mgr.groupForSession('s1')).toBeNull();
  });

  it('M5 importAll sanitizes: only structurally valid groups survive', () => {
    const mgr = new RuntimeGroupManager();
    const valid: RuntimeGroup = {
      id: 'g1', name: 'Valid', sessionIds: ['s1'],
      collapsed: false, createdAt: 1, updatedAt: 2,
    };

    mgr.importAll([
      valid,
      { garbage: true } as unknown as RuntimeGroup,
      { id: 'x', name: 'y', sessionIds: 'notarray' } as unknown as RuntimeGroup,
    ]);

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('g1');
    expect(list[0].sessionIds).toEqual(['s1']);
  });

  it('ensureGroup: creates once by exact id, returns the same group on repeat', () => {
    const mgr = new RuntimeGroupManager();

    const created = mgr.ensureGroup('fixed-id', 'N');
    expect(created.id).toBe('fixed-id');
    expect(created.name).toBe('N');

    const again = mgr.ensureGroup('fixed-id', 'DIFFERENT');
    expect(again).toBe(created);
    expect(mgr.list().filter(g => g.id === 'fixed-id')).toHaveLength(1);

    // Creating an unrelated group must not affect ensureGroup returning existing.
    mgr.create('other');
    expect(mgr.ensureGroup('fixed-id', 'whatever')).toBe(created);
  });

  it('persist callback: called after mutations with a snapshot reflecting state', () => {
    let last: RuntimeGroup[] | null = null;
    const persist = vi.fn((groups: RuntimeGroup[]) => { last = groups; });
    const mgr = new RuntimeGroupManager(persist);

    const a = mgr.create('A');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(last!.map(g => g.id)).toEqual([a.id]);

    mgr.addSession(a.id, 's1');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(last!.find(g => g.id === a.id)!.sessionIds).toEqual(['s1']);

    // Snapshot must be a copy — mutating it must not affect the manager.
    last!.find(g => g.id === a.id)!.sessionIds.push('leak');
    expect(mgr.get(a.id)!.sessionIds).toEqual(['s1']);
  });

  it('uses the injected clock for deterministic timestamps', () => {
    let t = 1000;
    const mgr = new RuntimeGroupManager(undefined, () => t);
    const a = mgr.create('A');
    expect(a.createdAt).toBe(1000);
    expect(a.updatedAt).toBe(1000);

    t = 2000;
    mgr.addSession(a.id, 's1');
    expect(mgr.get(a.id)!.updatedAt).toBe(2000);
  });

  it('sets a palette colour and rejects one outside the palette', () => {
    const persist = vi.fn();
    const mgr = new RuntimeGroupManager(persist);
    const a = mgr.create('A');

    expect(mgr.setColor(a.id, RUNTIME_GROUP_COLORS[2])!.color).toBe(RUNTIME_GROUP_COLORS[2]);
    expect(() => mgr.setColor(a.id, '#123456')).toThrow(/colour/i);
    expect(mgr.get(a.id)!.color).toBe(RUNTIME_GROUP_COLORS[2]);
    expect(mgr.setColor('missing', RUNTIME_GROUP_COLORS[0])).toBeNull();
  });
});
