/**
 * Artifact attachment types — binary files stored alongside artifacts.
 *
 * When a user manually creates an artifact from a file (drag-drop, paste,
 * file picker), the file bytes are stored on disk under the config dir.
 * The artifact's markdown content references the stored file via a local
 * path that the existing helm-img:// protocol serves to the renderer.
 */

/**
 * Scheme for the in-artifact "open this attachment" link.
 *
 * It is an app-internal identifier, never a filesystem path and never
 * navigable: main writes it into the artifact markdown, the renderer's
 * sanitizer allows it on <a href> only, and ArtifactViewer receives the click
 * from the artifact frame and routes it to artifact:openAttachment. Absolute paths cannot be
 * used here — the sanitizer strips them, which is why the original link was
 * dead on click.
 */
export const ATTACHMENT_LINK_SCHEME = 'helm-attachment:';

/** Build the link main embeds in an attachment artifact's markdown. */
export function buildAttachmentHref(artifactId: string, attachmentId: string): string {
  return `${ATTACHMENT_LINK_SCHEME}//${artifactId}/${attachmentId}`;
}

/** Parse an attachment link back to its ids, or null when it is not one. */
export function parseAttachmentHref(href: string): { artifactId: string; attachmentId: string } | null {
  if (!href.toLowerCase().startsWith(ATTACHMENT_LINK_SCHEME)) return null;
  const [artifactId, attachmentId, ...rest] = href.slice(ATTACHMENT_LINK_SCHEME.length + 2).split('/');
  if (!artifactId || !attachmentId || rest.length > 0) return null;
  return { artifactId, attachmentId };
}

/** A binary file attached to an artifact. */
export interface ArtifactAttachment {
  /** Unique attachment identifier (UUID v4). */
  id: string;
  /** Parent artifact id. */
  artifactId: string;
  /** Sanitized original filename. */
  filename: string;
  /** MIME type hint from the source (not trusted for security decisions). */
  contentType?: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Whole-file integrity hash, used for generated media transfers. */
  sha256?: string;
  /** Uses the generated-media cap, never the ordinary chat attachment cap. */
  generatedMedia?: boolean;
  /** Relative path from the attachments root: {artifactId}/{uuid}{ext}. */
  relativePath: string;
  /** Epoch ms when the attachment was created. */
  createdAt: number;
}
