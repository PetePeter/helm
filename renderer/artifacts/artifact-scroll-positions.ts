/**
 * Where each artifact version was last scrolled to, keyed `artifactId:version`.
 *
 * Module-level so it outlives the viewer: closing the pane or switching to
 * another artifact and back still lands where you were. In-memory only —
 * artifacts are ephemeral, and so is this. A new version is a new key, so it
 * opens at the top.
 */
export const artifactScrollPositions = new Map<string, number>();
