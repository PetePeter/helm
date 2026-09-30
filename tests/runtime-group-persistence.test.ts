/**
 * Runtime-group persistence unit tests.
 *
 * Mirrors draft-persistence: node:fs is mocked so we never touch the real
 * filesystem, and round-trips feed the written YAML back into the loader.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import type { RuntimeGroup } from '../src/types/runtime-group.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { saveRuntimeGroups, loadRuntimeGroups } from '../src/session/runtime-group-persistence.js';

const groupA: RuntimeGroup = {
  id: 'g1', name: 'Alpha', sessionIds: ['s1', 's2'],
  collapsed: false, createdAt: 1700000000000, updatedAt: 1700000001000,
};
const groupB: RuntimeGroup = {
  id: 'g2', name: 'Beta', sessionIds: [],
  collapsed: true, createdAt: 1700000002000, updatedAt: 1700000003000, color: '#2ec4b6',
};

describe('runtime-group persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('P1 save→load round-trip preserves groups', () => {
    saveRuntimeGroups([groupA, groupB]);

    const [, writtenContent] = (fs.writeFileSync as any).mock.calls[0];
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(writtenContent);

    const loaded = loadRuntimeGroups();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(groupA);
    expect(loaded[1]).toEqual(groupB);
  });

  it('drops a colour that is not in the palette, keeping the group', () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      'groups:\n  - { id: g1, name: A, sessionIds: [], collapsed: false, createdAt: 1, updatedAt: 1, color: "#123456" }\n',
    );

    expect(loadRuntimeGroups()[0]).toEqual({ id: 'g1', name: 'A', sessionIds: [], collapsed: false, createdAt: 1, updatedAt: 1 });
  });

  it('P2 missing file → []', () => {
    (fs.existsSync as any).mockReturnValue(false);
    expect(loadRuntimeGroups()).toEqual([]);
  });

  it('P3 malformed YAML (a bare string) → [] and does not throw', () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('just a string');

    let result: RuntimeGroup[] = [];
    expect(() => { result = loadRuntimeGroups(); }).not.toThrow();
    expect(result).toEqual([]);
  });

  it('drops structurally invalid entries on load', () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      'groups:\n' +
      '  - id: g1\n    name: Ok\n    sessionIds: []\n    collapsed: false\n    createdAt: 1\n    updatedAt: 1\n' +
      '  - id: 123\n    name: bad-id-type\n    sessionIds: []\n' +
      '  - name: no-id\n    sessionIds: []\n',
    );

    const loaded = loadRuntimeGroups();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('g1');
  });
});
