/**
 * Artifact strip list — kind/intent tri-state filters plus one sort mode,
 * persisted as the shared `artifact.list` filter preference so every window
 * showing artifacts agrees.
 */
import type { Artifact, ArtifactIntent } from '../../src/types/artifact.js';
import type { FilterPreferenceState } from '../../src/types/filter-preference.js';
import { coerceTriState, matchesTriStateGroup } from '../stores/filter-preferences.js';
import { ARTIFACT_KIND_LABELS, artifactKindLabel, type ArtifactKindLabel } from '../../src/session/artifact-kind-label.js';

export { ARTIFACT_KIND_LABELS, artifactKindLabel, type ArtifactKindLabel };

export const ARTIFACT_INTENTS = ['manifesto', 'normal'] as const satisfies readonly ArtifactIntent[];
export const ARTIFACT_SORTS = ['created', 'updated', 'az'] as const;
export type ArtifactSort = typeof ARTIFACT_SORTS[number];

export interface ArtifactListPrefs {
  kinds: Record<ArtifactKindLabel, FilterPreferenceState>;
  intents: Record<ArtifactIntent, FilterPreferenceState>;
  sort: ArtifactSort;
}

export const ARTIFACT_LIST_PREFERENCE_ID = 'artifact.list';

export function defaultArtifactListPrefs(): ArtifactListPrefs {
  return {
    kinds: { MD: 'either', HTML: 'either', IMG: 'either', BIN: 'either', COMPACT: 'either' },
    intents: { manifesto: 'either', normal: 'either' },
    sort: 'updated',
  };
}

export function normalizeArtifactListPrefs(saved: unknown): ArtifactListPrefs {
  const src = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const group = <K extends string>(keys: readonly K[], raw: unknown): Record<K, FilterPreferenceState> => {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return Object.fromEntries(keys.map(k => [k, coerceTriState(obj[k])])) as Record<K, FilterPreferenceState>;
  };
  return {
    kinds: group(ARTIFACT_KIND_LABELS, src.kinds),
    intents: group(ARTIFACT_INTENTS, src.intents),
    sort: (ARTIFACT_SORTS as readonly unknown[]).includes(src.sort) ? src.sort as ArtifactSort : defaultArtifactListPrefs().sort,
  };
}

const SORTERS: Record<ArtifactSort, (a: Artifact, b: Artifact) => number> = {
  created: (a, b) => b.createdAt - a.createdAt,
  updated: (a, b) => b.updatedAt - a.updatedAt,
  az: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
};

export function listArtifacts(artifacts: readonly Artifact[], prefs: ArtifactListPrefs): Artifact[] {
  return artifacts
    .filter(a => matchesTriStateGroup(prefs.kinds, artifactKindLabel(a))
      && matchesTriStateGroup(prefs.intents, a.intent ?? 'normal'))
    .sort(SORTERS[prefs.sort]);
}
