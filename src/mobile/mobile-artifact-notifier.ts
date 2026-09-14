/**
 * MobileArtifactNotifier — an artifact changing on the desktop buzzes the
 * phone, the same path MobileAlertNotifier opened.
 *
 * A report an agent just wrote is exactly the thing you want in your pocket
 * without walking back to the desk, and it rides the already-open GATT link for
 * free. It inherits its sibling's three refusals — NO DEDUPLICATION (the phone
 * keys the row on the artifact id), NO PREFERENCES, NO RETRY — for the same
 * reasons; see mobile-alert-notifier.ts.
 *
 * It listens to BOTH ArtifactManager events because neither is sufficient
 * alone, and together they say exactly one thing:
 *
 *   'artifact:reveal' always follows a create or an update, but it ALSO fires
 *   when nothing changed — `artifact_show` and the desktop viewer reveal to
 *   bring an already-read artifact forward, and re-opening it is not news. So
 *   'changed' — which names the ids that moved — marks those ARTIFACTS dirty,
 *   and a reveal spends the mark only for its own artifact. A session-level
 *   mark would leak across artifacts: rename A, then open B, and B would be
 *   buzzed about a change that happened to A.
 *
 * Deletions mark artifacts that can never be revealed again; the marks simply
 * die with the set. Nothing buzzes about something that no longer exists.
 *
 * The manager is read for the artifact's CURRENT title rather than trusting the
 * event, so a rename between the change and the push names the artifact what it
 * is called now, not what it was called a tick ago.
 */

import { logger } from '../utils/logger.js';
import type { ArtifactManager } from '../session/artifact-manager.js';

/** The slice of MobileChatBridge this drives. Narrow by design: no gate, no BLE. */
export interface MobileArtifactSink {
  sendArtifact(sessionId: string, artifactId: string, title: string): boolean;
}

/** The slice of ArtifactManager the notifier reads titles from. */
export type MobileArtifactLookup = Pick<ArtifactManager, 'get'>;

export class MobileArtifactNotifier {
  /** Per session: the artifacts with an unreported change, spent by their own reveal. */
  private readonly dirty = new Map<string, Set<string>>();

  constructor(
    private readonly sink: MobileArtifactSink,
    private readonly artifacts: MobileArtifactLookup,
  ) {}

  /** `artifact:changed` — these of this session's artifacts mutated. */
  changed(sessionId: string, artifactIds: string[]): void {
    if (artifactIds.length === 0) return;
    const marks = this.dirty.get(sessionId) ?? new Set<string>();
    for (const artifactId of artifactIds) marks.add(artifactId);
    this.dirty.set(sessionId, marks);
  }

  /**
   * `artifact:reveal` — pushes only when THIS artifact has a change waiting to
   * be explained. Another artifact's change never rides on this reveal.
   * Spending a session's LAST mark drops its set: an empty set is residue a
   * finished buzz leaves behind, not state.
   */
  revealed(sessionId: string, artifactId: string): void {
    const marks = this.dirty.get(sessionId);
    if (!marks?.delete(artifactId)) return;
    if (marks.size === 0) this.dirty.delete(sessionId);
    const title = this.artifacts.get(artifactId)?.title;
    if (!title) return;
    this.push(sessionId, artifactId, title);
  }

  /** Nothing here throws into a caller: a notice never breaks what triggered it. */
  private push(sessionId: string, artifactId: string, title: string): void {
    try {
      this.sink.sendArtifact(sessionId, artifactId, title);
    } catch (error) {
      logger.warn(`[MobileArtifact] Could not push an artifact notice: ${error}`);
    }
  }
}
