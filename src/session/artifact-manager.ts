/**
 * ArtifactManager — in-memory store of versioned, renderable session outputs.
 *
 * Mirrors the DraftManager pattern: an injected `persist` sink is invoked on
 * every mutation with the full export, and an `artifact:changed` event carries
 * the affected sessionId plus the ids that changed — the ids let a listener tell
 * WHICH artifact moved, which a session-level event alone cannot (a rename or a
 * clear changes one artifact, not all of them). The clock is injectable so
 * timestamps are deterministic in tests.
 *
 * Artifacts are keyed by sessionId. Each `create()` always mints a distinct
 * artifact (its own uuid) — duplicate titles are allowed. Subsequent versions
 * are added via uuid-based `update()`.
 *
 * A separate `artifact:reveal` event (sessionId, artifactId) signals the UI to
 * bring an artifact forward. It fires on create/update and on the explicit
 * `reveal()` call (which backs the MCP `artifact_show` tool without mutating).
 *
 * Ephemeral behaviour: the caller invokes `clearSession()` from the
 * `session:removed` listener, so artifacts die with their session. This class
 * only exposes the operation.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { Artifact, ArtifactKind, ArtifactSource } from '../types/artifact.js';

export class ArtifactManager extends EventEmitter {
  private artifacts = new Map<string, Artifact[]>(); // sessionId -> artifacts

  constructor(
    private readonly persist?: (all: Record<string, Artifact[]>) => void,
    private readonly now: () => number = Date.now,
    private readonly onDelete?: (artifactId: string) => void,
  ) {
    super();
  }

  /**
   * Create a NEW artifact (version 1) for a session and return it. Always mints
   * a distinct uuid — duplicate titles are permitted. Emits 'artifact:reveal'
   * so the UI brings the new artifact forward.
   *
   * `id` lets a caller supply a pre-minted uuid for the artifact. That exists so
   * side files keyed by artifact id (attachments) can be written BEFORE the
   * artifact, letting version 1 hold the real content instead of being seeded
   * empty and immediately updated.
   */
  create(sessionId: string, title: string, kind: ArtifactKind, content: string, source?: ArtifactSource, id?: string): Artifact {
    const ts = this.now();
    const artifact: Artifact = {
      id: id ?? randomUUID(),
      sessionId,
      title,
      kind,
      versions: [{ version: 1, content, createdAt: ts }],
      createdAt: ts,
      updatedAt: ts,
      ...(source ? { source } : {}),
    };
    if (!this.artifacts.has(sessionId)) this.artifacts.set(sessionId, []);
    this.artifacts.get(sessionId)!.push(artifact);
    this.markChanged(sessionId, [artifact.id]);
    this.emitReveal(sessionId, artifact.id);
    logger.info(`[ArtifactManager] Created artifact "${title}" for session ${sessionId}`);
    return artifact;
  }

  /**
   * Append a new version to an existing artifact. Returns it, or null if
   * unknown. Emits 'artifact:reveal' so the UI brings it forward.
   */
  update(artifactId: string, content: string): Artifact | null {
    for (const [sessionId, artifacts] of this.artifacts) {
      const artifact = artifacts.find(a => a.id === artifactId);
      if (artifact) {
        this.appendVersion(artifact, content);
        this.markChanged(sessionId, [artifact.id]);
        this.emitReveal(sessionId, artifact.id);
        return artifact;
      }
    }
    return null;
  }

  /**
   * Bring an existing artifact forward in the UI without mutating it. Emits
   * 'artifact:reveal' and returns true; false if the id is unknown. Backs the
   * MCP `artifact_show(id)` tool.
   */
  reveal(artifactId: string): boolean {
    for (const [sessionId, artifacts] of this.artifacts) {
      if (artifacts.some(a => a.id === artifactId)) {
        this.emitReveal(sessionId, artifactId);
        return true;
      }
    }
    return false;
  }

  /** Get a single artifact by id. */
  get(artifactId: string): Artifact | null {
    for (const artifacts of this.artifacts.values()) {
      const found = artifacts.find(a => a.id === artifactId);
      if (found) return found;
    }
    return null;
  }

  /** All artifacts for a session (copies), newest updatedAt first. */
  getForSession(sessionId: string): Artifact[] {
    return [...(this.artifacts.get(sessionId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Number of artifacts owned by a session. */
  count(sessionId: string): number {
    return this.artifacts.get(sessionId)?.length ?? 0;
  }

  /** Delete a single artifact by id. Returns true if found and removed. */
  delete(artifactId: string): boolean {
    for (const [sessionId, artifacts] of this.artifacts) {
      const idx = artifacts.findIndex(a => a.id === artifactId);
      if (idx >= 0) {
        artifacts.splice(idx, 1);
        if (artifacts.length === 0) this.artifacts.delete(sessionId);
        this.markChanged(sessionId, [artifactId]);
        this.onDelete?.(artifactId);
        logger.info(`[ArtifactManager] Deleted artifact ${artifactId}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Rename an artifact. Returns true if found and renamed.
   */
  rename(artifactId: string, newTitle: string): boolean {
    for (const [sessionId, artifacts] of this.artifacts) {
      const artifact = artifacts.find(a => a.id === artifactId);
      if (artifact) {
        artifact.title = newTitle;
        artifact.updatedAt = this.now();
        this.markChanged(sessionId, [artifact.id]);
        return true;
      }
    }
    return false;
  }

  /** Remove every artifact owned by a session. */
  deleteAllForSession(sessionId: string): void {
    const artifacts = this.artifacts.get(sessionId);
    if (artifacts) {
      this.artifacts.delete(sessionId);
      for (const artifact of artifacts) this.onDelete?.(artifact.id);
      this.markChanged(sessionId, artifacts.map(a => a.id));
      logger.info(`[ArtifactManager] Deleted all artifacts for session ${sessionId}`);
    }
  }

  /** Alias for deleteAllForSession, kept for call-site clarity on session close. */
  clearSession(sessionId: string): void {
    this.deleteAllForSession(sessionId);
  }

  /** Export all artifacts for persistence (sessions with 0 artifacts omitted). */
  exportAll(): Record<string, Artifact[]> {
    const result: Record<string, Artifact[]> = {};
    for (const [sessionId, artifacts] of this.artifacts) {
      if (artifacts.length > 0) result[sessionId] = [...artifacts];
    }
    return result;
  }

  /** Import persisted artifacts (called on startup); malformed entries dropped. */
  importAll(data: Record<string, Artifact[]>): void {
    this.artifacts.clear();
    for (const [sessionId, artifacts] of Object.entries(data)) {
      if (Array.isArray(artifacts) && artifacts.length > 0) {
        this.artifacts.set(sessionId, [...artifacts]);
      }
    }
    logger.info(`[ArtifactManager] Imported artifacts for ${Object.keys(data).length} session(s)`);
  }

  /** Append the next version and advance updatedAt. Mutates the artifact in place. */
  private appendVersion(artifact: Artifact, content: string): void {
    const ts = this.now();
    const version = artifact.versions[artifact.versions.length - 1].version + 1;
    artifact.versions.push({ version, content, createdAt: ts });
    artifact.updatedAt = ts;
  }

  private emitReveal(sessionId: string, artifactId: string): void {
    this.emit('artifact:reveal', sessionId, artifactId);
  }

  private markChanged(sessionId: string, artifactIds: string[]): void {
    this.persist?.(this.exportAll());
    this.emit('artifact:changed', sessionId, artifactIds);
  }
}
