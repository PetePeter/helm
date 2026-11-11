import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/types/artifact.js';
import {
  defaultArtifactListPrefs,
  listArtifacts,
  normalizeArtifactListPrefs,
} from '../renderer/artifacts/artifact-list.js';

function art(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    title: id,
    kind: 'markdown',
    source: 'ai',
    intent: 'normal',
    createdAt: 0,
    updatedAt: 0,
    versions: [{ version: 1, content: '# x', createdAt: 0 }],
    ...over,
  } as Artifact;
}

const ids = (list: Artifact[]) => list.map(a => a.id);

describe('listArtifacts', () => {
  const md = art('md', { createdAt: 1, updatedAt: 30, title: 'Charlie' });
  const html = art('html', { kind: 'html', createdAt: 3, updatedAt: 10, title: 'alpha' });
  const compact = art('compact', { kind: 'compact', intent: 'manifesto', createdAt: 2, updatedAt: 20, title: 'Bravo' });
  const all = [md, html, compact];

  it('shows everything with default prefs', () => {
    expect(ids(listArtifacts(all, defaultArtifactListPrefs()))).toHaveLength(3);
  });

  it('a "yes" kind chip narrows to that kind; a "no" chip excludes it', () => {
    const prefs = defaultArtifactListPrefs();
    prefs.kinds.HTML = 'yes';
    expect(ids(listArtifacts(all, prefs))).toEqual(['html']);
    prefs.kinds.HTML = 'no';
    expect(ids(listArtifacts(all, prefs)).sort()).toEqual(['compact', 'md']);
  });

  it('kind and intent groups combine', () => {
    const prefs = defaultArtifactListPrefs();
    prefs.intents.manifesto = 'yes';
    expect(ids(listArtifacts(all, prefs))).toEqual(['compact']);
    prefs.kinds.COMPACT = 'no';
    expect(listArtifacts(all, prefs)).toEqual([]);
  });

  it('sorts by created, updated (newest first) and A–Z (case-insensitive)', () => {
    const prefs = defaultArtifactListPrefs();
    prefs.sort = 'created';
    expect(ids(listArtifacts(all, prefs))).toEqual(['html', 'compact', 'md']);
    prefs.sort = 'updated';
    expect(ids(listArtifacts(all, prefs))).toEqual(['md', 'compact', 'html']);
    prefs.sort = 'az';
    expect(ids(listArtifacts(all, prefs))).toEqual(['html', 'compact', 'md']);
  });
});

describe('normalizeArtifactListPrefs', () => {
  it('repairs garbage from disk and keeps valid fields', () => {
    const prefs = normalizeArtifactListPrefs({ sort: 'bogus', kinds: { MD: 'yes', HTML: 7 }, intents: null });
    expect(prefs.sort).toBe(defaultArtifactListPrefs().sort);
    expect(prefs.kinds.MD).toBe('yes');
    expect(prefs.kinds.HTML).toBe('either');
    expect(prefs.intents).toEqual(defaultArtifactListPrefs().intents);
  });
});
