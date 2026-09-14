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
 *   'artifact:changed' carries no artifact id — but 'artifact:reveal' always
 *   follows it for a create or an update, carrying the id. So 'changed' marks
 *   the session dirty and 'reveal' spends the mark. That pairing is what keeps
 *   a bare reveal quiet: `artifact_show` and the desktop viewer both reveal
 *   without changing anything, and re-opening something you have already read
 *   is not news.
 *
 * Deletions ('changed' with no reveal) are deliberately not buzz-worthy — the
 * artifact they would name no longer exists.
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
  /** Sessions with an unreported change; consumed by the reveal that explains it. */
  private readonly dirty = new Set<string>();

  constructor(
    private readonly sink: MobileArtifactSink,
    private readonly artifacts: MobileArtifactLookup,
  ) {}

  /** `artifact:changed` — something about this session's artifacts mutated. */
  changed(sessionId: string): void {
    this.dirty.add(sessionId);
  }

  /** `artifact:reveal` — pushes only when a change is waiting to be explained. */
  revealed(sessionId: string, artifactId: string): void {
    if (!this.dirty.delete(sessionId)) return;
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
