import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/types/artifact.js';
import { artifactKindLabel } from '../src/session/artifact-kind-label.js';
import { listArtifacts, normalizeArtifactListPrefs } from '../renderer/artifacts/artifact-list.js';

/** The same vectors the Android ArtifactListRulesTest reads, so both strips agree. */
const vectors = JSON.parse(readFileSync(new URL('./fixtures/artifact-list-vectors.json', import.meta.url), 'utf-8'));

type Row = { id: string; title: string; kind: Artifact['kind']; label: string; intent: Artifact['intent']; createdAt: number; updatedAt: number };

/** Build a real Artifact whose derived label is the vector's label. */
function toArtifact(r: Row): Artifact {
  const content = r.label === 'IMG' ? '![x](helm-img://x)' : r.label === 'BIN' ? 'Open in system viewer' : '# x';
  return {
    id: r.id, title: r.title, kind: r.kind, intent: r.intent,
    source: r.label === 'IMG' || r.label === 'BIN' ? 'manual' : 'ai',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    versions: [{ version: 1, content, createdAt: r.createdAt }],
  } as Artifact;
}

describe('artifact list vectors', () => {
  const artifacts = (vectors.artifacts as Row[]).map(toArtifact);

  it('derives every vector label', () => {
    expect(artifacts.map(artifactKindLabel)).toEqual((vectors.artifacts as Row[]).map(r => r.label));
  });

  for (const c of vectors.cases as Array<{ name: string; prefs: unknown; expected: string[] }>) {
    it(c.name, () => {
      expect(listArtifacts(artifacts, normalizeArtifactListPrefs(c.prefs)).map(a => a.id)).toEqual(c.expected);
    });
  }
});
