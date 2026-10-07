import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Artifact } from '../src/types/artifact.js';

// Mock the file layer so persistence can be exercised without touching disk.
const files = new Map<string, string>();

vi.mock('../src/session/persistence-utils.js', async () => {
  const actual = await vi.importActual<typeof import('../src/session/persistence-utils.js')>('../src/session/persistence-utils.js');
  return {
    ...actual,
    atomicWriteFileSync: (filePath: string, content: string) => {
      files.set(filePath, content);
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => files.has(String(p)),
    readFileSync: (p: string) => {
      const v = files.get(String(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
  };
});

import { saveArtifacts, loadArtifacts } from '../src/session/artifact-persistence.js';
import { ARTIFACTS_FILE } from '../src/session/persistence-paths.js';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a1',
    sessionId: 's1',
    title: 'Report',
    kind: 'markdown',
    versions: [{ version: 1, content: 'body', createdAt: 100 }],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('artifact-persistence', () => {
  beforeEach(() => files.clear());
  afterEach(() => vi.clearAllMocks());

  it('round-trips save -> load with equality', () => {
    const data: Record<string, Artifact[]> = {
      s1: [makeArtifact()],
      s2: [makeArtifact({ id: 'a2', sessionId: 's2', title: 'Other', kind: 'html' })],
    };
    saveArtifacts(data);
    const loaded = loadArtifacts();
    expect(loaded).toEqual(data);
  });

  // An unsaved draft is the user's work: it has to outlive a restart.
  it('keeps an unsaved draft across save -> load', () => {
    const data = { s1: [makeArtifact({ draft: { content: 'half-written', updatedAt: 200 } })] };
    saveArtifacts(data);
    expect(loadArtifacts()).toEqual(data);
  });

  it('drops a malformed draft but keeps the artifact', () => {
    saveArtifacts({ s1: [makeArtifact({ draft: { content: 42 } as unknown as Artifact['draft'] })] });
    expect(loadArtifacts()).toEqual({ s1: [makeArtifact()] });
  });

  it('returns {} when the file does not exist', () => {
    expect(loadArtifacts()).toEqual({});
  });

  it('drops malformed / garbage entries on load', async () => {
    const YAML = await importYaml();
    files.set(ARTIFACTS_FILE, YAML.stringify({
      artifacts: {
        good: [makeArtifact()],
        bad1: 'not-an-array',
        bad2: [{ id: 'x' /* missing fields */ }],
        bad3: [{ ...makeArtifact(), versions: 'nope' }],
        empty: [],
      },
    }));

    const loaded = loadArtifacts();
    expect(Object.keys(loaded)).toEqual(['good']);
    expect(loaded.good).toHaveLength(1);
  });

  it('returns {} when the payload is entirely garbage', async () => {
    const YAML = await importYaml();
    files.set(ARTIFACTS_FILE, YAML.stringify({ artifacts: 42 }));
    expect(loadArtifacts()).toEqual({});
  });

  it('preserves artifacts with unknown intent as normal', async () => {
    const YAML = await importYaml();
    files.set(ARTIFACTS_FILE, YAML.stringify({
      artifacts: { s1: [makeArtifact({ intent: 'future-value' as Artifact['intent'] })] },
    }));
    expect(loadArtifacts().s1[0].intent).toBe('normal');
  });

  it('rejects an artifact with an empty version stack', async () => {
    const YAML = await importYaml();
    files.set(ARTIFACTS_FILE, YAML.stringify({
      artifacts: {
        s1: [makeArtifact({ versions: [] }), makeArtifact({ id: 'a2' })],
      },
    }));

    const loaded = loadArtifacts();
    // The versionless artifact is dropped; the well-formed one survives.
    expect(loaded.s1).toHaveLength(1);
    expect(loaded.s1[0].id).toBe('a2');
  });
});

// yaml is a runtime dep; import lazily to avoid top-level await in test setup.
async function importYaml() {
  return await import('yaml');
}
