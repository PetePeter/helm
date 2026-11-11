/**
 * The kind label every artifact strip shows and filters on. Lives in main
 * (not the renderer) because the phone list needs it too and cannot derive
 * IMG/BIN itself — it never receives version content in a list.
 */
import type { Artifact } from '../types/artifact.js';

export const ARTIFACT_KIND_LABELS = ['MD', 'HTML', 'IMG', 'BIN', 'COMPACT'] as const;
export type ArtifactKindLabel = typeof ARTIFACT_KIND_LABELS[number];

/** IMG for image-based markdown, BIN for binary, COMPACT for a compaction snapshot, otherwise MD/HTML. */
export function artifactKindLabel(a: Artifact): ArtifactKindLabel {
  if (a.source === 'manual') {
    const content = a.versions[a.versions.length - 1]?.content ?? '';
    if (content.startsWith('![')) return 'IMG';
    if (content.includes('Open in system viewer')) return 'BIN';
  }
  if (a.kind === 'compact') return 'COMPACT';
  return a.kind === 'markdown' ? 'MD' : 'HTML';
}
