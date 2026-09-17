/**
 * chat-attachment-registrar — how a file sent over chat becomes something a
 * phone can fetch.
 *
 * THE PROBLEM. `chat_send` takes an absolute path, and that is exactly right
 * for Telegram: Helm uploads the bytes and Telegram's servers carry them. The
 * paired phone has no server in the middle — BLE or LAN direct is the only pipe
 * — so a desktop path reaches it as a string it can never open. The phone needs
 * an ID it can ask for, and Helm needs to still be holding the bytes when it
 * does, which a caller's temp file will not guarantee.
 *
 * THE ANSWER. Take Helm's own copy through the machinery that already exists
 * for exactly this: artifact attachments. They are per-session, they survive
 * until the session ends, they are already capped at 10MB, and they are already
 * reachable from a phone through the allow-listed `session_artifact_*` family.
 * Building a second store beside them would have duplicated all four properties
 * and given the user two places to look for one file.
 *
 * ONE ARTIFACT PER SESSION holds them all, rather than one artifact per file: a
 * chatty afternoon would otherwise bury a session's real reports under forty
 * single-file rows.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { mimeForPath } from '../../electron/helm-img-protocol.js';
import { logger } from '../../utils/logger.js';
import type { ChatAttachmentRef } from './chat-bridge.js';
import type { ArtifactAttachmentManager } from '../artifact-attachment-manager.js';
import type { Artifact } from '../../types/artifact.js';

/** The one artifact per session that chat files are filed under. */
export const CHAT_FILES_TITLE = 'Chat files';

const CHAT_FILES_BODY =
  'Files sent to this session over chat. Delete one from the phone, or delete\n' +
  'this artifact to remove them all.\n';

const FALLBACK_MIME = 'application/octet-stream';

/** The slice of ArtifactManager this needs. Narrow so a test can stand it up. */
export interface ChatAttachmentArtifacts {
  getForSession(sessionId: string): Artifact[];
  create(sessionId: string, title: string, kind: 'markdown', content: string, source: 'manual'): Artifact;
}

export interface ChatAttachmentRegistrarDeps {
  artifacts: ChatAttachmentArtifacts;
  attachments: Pick<ArtifactAttachmentManager, 'add'>;
}

/**
 * Build the registrar the ChatBroker calls once per send.
 *
 * Returns undefined rather than throwing for every expected failure — a missing
 * file, an oversized one. A message whose file could not be taken is still a
 * message worth delivering, and Telegram's copy of it is unaffected either way.
 */
export function createChatAttachmentRegistrar(deps: ChatAttachmentRegistrarDeps) {
  return (sessionId: string, filePath: string): ChatAttachmentRef | undefined => {
    try {
      // stat before read: a 10MB refusal should not cost 10MB of memory first.
      if (!statSync(filePath).isFile()) return undefined;
      const content = readFileSync(filePath);
      const filename = basename(filePath);
      const mimeType = mimeForPath(filePath) ?? FALLBACK_MIME;

      const artifact = chatFilesArtifact(deps.artifacts, sessionId);
      const attachment = deps.attachments.add(artifact.id, { filename, content, contentType: mimeType });

      return {
        artifactId: artifact.id,
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.contentType ?? mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    } catch (error) {
      logger.warn(`[ChatAttachment] Could not take a copy of ${filePath}: ${error}`);
      return undefined;
    }
  };
}

/** The session's chat-files artifact, created the first time one is sent. */
function chatFilesArtifact(artifacts: ChatAttachmentArtifacts, sessionId: string): Artifact {
  const existing = artifacts.getForSession(sessionId).find(a => a.title === CHAT_FILES_TITLE);
  return existing ?? artifacts.create(sessionId, CHAT_FILES_TITLE, 'markdown', CHAT_FILES_BODY, 'manual');
}
