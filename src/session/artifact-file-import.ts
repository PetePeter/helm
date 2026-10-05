/**
 * Shared file-to-artifact import path used by MCP and renderer IPC.
 *
 * The caller supplies bytes; this module owns the artifact/attachment
 * transaction and guarantees that a failed import does not leave an orphaned
 * attachment or an empty artifact version.
 */

import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactIntent, ArtifactSource } from '../types/artifact.js';
import { buildAttachmentHref, type ArtifactAttachment } from '../types/artifact-attachment.js';
import { buildTextArtifact, isTextLikeFile, TEXT_INLINE_MAX_BYTES } from '../types/artifact-file.js';
import type { ArtifactAttachmentManager } from './artifact-attachment-manager.js';
import type { ArtifactManager } from './artifact-manager.js';

export interface ArtifactFileBytes {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ArtifactFileResult {
  artifact: Artifact;
  attachment?: ArtifactAttachment;
}

export function createArtifactFromBytes(
  artifactManager: ArtifactManager,
  attachmentManager: ArtifactAttachmentManager,
  sessionId: string,
  input: ArtifactFileBytes,
  title?: string,
  source: ArtifactSource = 'ai',
  inlineText = true,
  intent: ArtifactIntent = 'normal',
): ArtifactFileResult {
  if (inlineText && isTextLikeFile(input.filename, input.contentType) && input.content.byteLength <= TEXT_INLINE_MAX_BYTES) {
    const draft = buildTextArtifact(input.filename, input.content.toString('utf8'));
    return {
      artifact: artifactManager.create(sessionId, title ?? draft.title, 'markdown', draft.content, source, undefined, intent),
    };
  }

  const artifactId = randomUUID();
  try {
    const attachment = attachmentManager.add(artifactId, input);
    const content = buildAttachmentContent(attachmentManager, artifactId, attachment, input.contentType);
    const artifact = artifactManager.create(sessionId, title ?? input.filename, 'markdown', content, source, artifactId, intent);
    return { artifact, attachment };
  } catch (error) {
    try { attachmentManager.deleteForArtifact(artifactId); } catch { /* best effort rollback */ }
    throw error;
  }
}

export function updateArtifactFromBytes(
  artifactManager: ArtifactManager,
  attachmentManager: ArtifactAttachmentManager,
  artifact: Artifact,
  input: ArtifactFileBytes,
  intent?: ArtifactIntent,
): ArtifactFileResult {
  if (isTextLikeFile(input.filename, input.contentType) && input.content.byteLength <= TEXT_INLINE_MAX_BYTES) {
    const draft = buildTextArtifact(input.filename, input.content.toString('utf8'));
    return { artifact: artifactManager.update(artifact.id, draft.content, intent) ?? artifact };
  }

  const attachment = attachmentManager.add(artifact.id, input);
  try {
    const updated = artifactManager.update(
      artifact.id,
      buildAttachmentContent(attachmentManager, artifact.id, attachment, input.contentType),
      intent,
    );
    if (!updated) throw new Error(`Artifact not found: ${artifact.id}`);
    return { artifact: updated, attachment };
  } catch (error) {
    try { attachmentManager.delete(artifact.id, attachment.id); } catch { /* best effort rollback */ }
    throw error;
  }
}

function buildAttachmentContent(
  attachmentManager: ArtifactAttachmentManager,
  artifactId: string,
  attachment: ArtifactAttachment,
  contentType?: string,
): string {
  const type = contentType ?? 'application/octet-stream';
  if (type.startsWith('image/')) {
    return `![${attachment.filename}](${attachmentManager.getPath(artifactId, attachment.id)})\n`;
  }
  return `**${attachment.filename}** — ${formatBytes(attachment.sizeBytes)} — ${type}\n\n📎 [Open in system viewer](${buildAttachmentHref(artifactId, attachment.id)})\n`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
