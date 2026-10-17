/**
 * Tests for getOrderedSessionIds + buildSessionShortcutMap — pure ordering & slot logic.
 */

import { describe, it, expect } from 'vitest';
import { getOrderedSessionIds, buildSessionShortcutMap } from '../renderer/utils/session-shortcut-map.js';
import type { NavItem } from '../renderer/session-groups.js';

// ============================================================================
// Helpers
// ============================================================================

function makeSessionCard(id: string): NavItem {
  return { type: 'session-card' as const, id, groupIndex: 0 };
}

function makeGroupHeader(id: string): NavItem {
  return { type: 'group-header' as const, id, groupIndex: 0 };
}

// ============================================================================
// getOrderedSessionIds
// ============================================================================

describe('getOrderedSessionIds', () => {
  it('returns session-card ids in navList display order', () => {
    const navList: NavItem[] = [
      makeGroupHeader('/dir/a'),
      makeSessionCard('s1'),
      makeSessionCard('s2'),
      makeGroupHeader('/dir/b'),
      makeSessionCard('s3'),
    ];
    expect(getOrderedSessionIds(navList, new Set())).toEqual(['s1', 's2', 's3']);
  });

  it('excludes snapped-out session IDs', () => {
    const navList: NavItem[] = [
      makeSessionCard('a'),
      makeSessionCard('b'),
      makeSessionCard('c'),
    ];
    const snappedOut = new Set(['b']);
    expect(getOrderedSessionIds(navList, snappedOut)).toEqual(['a', 'c']);
  });

  it('collapsed sessions (absent from navList) are excluded', () => {
    const navList: NavItem[] = [
      makeGroupHeader('/dir/a'),   // group is collapsed — no session cards inside
      makeGroupHeader('/dir/b'),
      makeSessionCard('s3'),
    ];
    expect(getOrderedSessionIds(navList, new Set())).toEqual(['s3']);
  });

  it('collapsed sessions become reachable when navList includes them (group expanded)', () => {
    const collapsedNavList: NavItem[] = [
      makeGroupHeader('/dir/a'),   // collapsed — s1, s2 absent
      makeSessionCard('s3'),
    ];
    const expandedNavList: NavItem[] = [
      makeGroupHeader('/dir/a'),
      makeSessionCard('s1'),       // now visible
      makeSessionCard('s2'),       // now visible
      makeSessionCard('s3'),
    ];

    expect(getOrderedSessionIds(collapsedNavList, new Set())).toEqual(['s3']);
    expect(getOrderedSessionIds(expandedNavList, new Set())).toEqual(['s1', 's2', 's3']);
  });

  it('empty navList → empty array', () => {
    expect(getOrderedSessionIds([], new Set())).toEqual([]);
  });

  it('non-session-card items are ignored', () => {
    const navList: NavItem[] = [
      makeGroupHeader('/dir'),
      makeSessionCard('s1'),
    ];
    expect(getOrderedSessionIds(navList, new Set())).toEqual(['s1']);
  });
});

// ============================================================================
// buildSessionShortcutMap (slots 1–9 then 0)
// ============================================================================

describe('buildSessionShortcutMap', () => {
  it('assigns slots 1–9 then 0 to first 10 visible session-card nav items in order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const navList: NavItem[] = ids.map(makeSessionCard);
    const map = buildSessionShortcutMap(navList, new Set());

    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBe(2);
    expect(map.get('c')).toBe(3);
    expect(map.get('d')).toBe(4);
    expect(map.get('e')).toBe(5);
    expect(map.get('f')).toBe(6);
    expect(map.get('g')).toBe(7);
    expect(map.get('h')).toBe(8);
    expect(map.get('i')).toBe(9);
    expect(map.get('j')).toBe(0);
    expect(map.size).toBe(10);
  });

  it('skips snapped-out session IDs — subsequent sessions fill the gaps', () => {
    const navList: NavItem[] = ['a', 'b', 'c', 'd'].map(makeSessionCard);
    const snappedOut = new Set(['c']);
    const map = buildSessionShortcutMap(navList, snappedOut);

    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBe(2);
    expect(map.has('c')).toBe(false);
    expect(map.get('d')).toBe(3);
    expect(map.size).toBe(3);
  });

  it('sessions beyond position 10 get no entry in the map', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const navList: NavItem[] = ids.map(makeSessionCard);
    const map = buildSessionShortcutMap(navList, new Set());

    expect(map.has('k')).toBe(false);
    expect(map.has('l')).toBe(false);
    expect(map.size).toBe(10);
  });

  it('non-session-card nav items are ignored and do not consume slots', () => {
    const navList: NavItem[] = [
      makeGroupHeader('/dir/a'),
      makeSessionCard('s1'),
      makeSessionCard('s2'),
      makeGroupHeader('/dir/b'),
      makeSessionCard('s3'),
    ];
    const map = buildSessionShortcutMap(navList, new Set());

    expect(map.get('s1')).toBe(1);
    expect(map.get('s2')).toBe(2);
    expect(map.get('s3')).toBe(3);
    expect(map.size).toBe(3);
  });

  it('empty navList → empty map', () => {
    const map = buildSessionShortcutMap([], new Set());
    expect(map.size).toBe(0);
  });

  it('all sessions snapped-out → empty map', () => {
    const navList: NavItem[] = ['a', 'b', 'c'].map(makeSessionCard);
    const map = buildSessionShortcutMap(navList, new Set(['a', 'b', 'c']));
    expect(map.size).toBe(0);
  });
});

// ============================================================================
// Consistency: shortcut map key order == getOrderedSessionIds order
// ============================================================================

describe('ordering consistency', () => {
  it('shortcut map key order matches getOrderedSessionIds for the same inputs', () => {
    const navList: NavItem[] = [
      makeGroupHeader('/dir/x'),
      makeSessionCard('s1'),
      makeSessionCard('s2'),
      makeGroupHeader('/dir/y'),
      makeSessionCard('s3'),
      makeSessionCard('s4'),
      makeSessionCard('s5'),
    ];
    const snappedOut = new Set(['s4']);

    const orderedIds = getOrderedSessionIds(navList, snappedOut);
    const map = buildSessionShortcutMap(navList, snappedOut);

    // Map keys follow insertion order, which is navList display order
    expect([...map.keys()]).toEqual(orderedIds);
  });
});
