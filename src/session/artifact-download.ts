/**
 * artifact-download — the bounded envelopes a remote surface receives for an
 * artifact, whether it asks for a file or for inline content.
 *
 * WHY A CAP: artifacts are unbounded markdown/HTML, but a phone reads them over
 * a SecureChannel whose frames ceiling is 128KiB (MAX_FRAME_BYTES). The two
 * envelopes inflate differently on the way, so each has its own authority:
 *
 *  - A DOWNLOAD body is base64 — 3 bytes become 4 chars, and the output alphabet
 *    is JSON-inert, so encoding is the ONLY inflation. The authority is the
 *    encoded length, with a decoded pre-check ahead of it only so the error
 *    names a byte count instead of paying to encode a body that cannot fit.
 *  - An INLINE READ body is a plain JSON string inside the result record, and
 *    JSON escaping can inflate it up to 6x: a quote or a backslash doubles, a
 *    control character becomes a 6-byte `\u00XX` escape. A decoded-only cap
 *    once accepted a frame-full of quotes that escaped to ~1.5 frames and tore
 *    the link, so the authority here is the MEASURED JSON-encoded length, with
 *    the decoded pre-check only to condemn absurd bodies without stringify.
 *
 * An oversized artifact refuses legibly and points at the desktop, where the
 * artifact viewer renders it in full.
 */

import { logger } from '../utils/logger.js';
import type { Artifact, ArtifactKind } from '../types/artifact.js';

/**
 * Room for everything that rides WITH the body on the wire: the JSON-RPC
 * result wrapper, the record envelope, the AEAD overhead. Generous on purpose —
 * under-reserving here fails as a torn link, which is the failure this cap
 * exists to prevent.
 */
export const DOWNLOAD_WRAPPER_HEADROOM_BYTES = 2 * 1024;

/**
 * The wire budget for an encoded artifact body: the mobile frame ceiling minus
 * the wrapper headroom. Pinned to MAX_FRAME_BYTES (src/mobile/secure-channel.ts)
 * by a test, so raising either side alone fails loudly.
 */
export const ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES = 128 * 1024 - DOWNLOAD_WRAPPER_HEADROOM_BYTES;

/**
 * The largest DECODED body that could fit the encoded budget (base64 is 4 chars
 * per 3 bytes). A pre-check, not the authority — the encoded length decides.
 */
export const ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES = Math.floor(ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES / 4) * 3;

/**
 * The wire budget for an inline read's body, measured in its JSON-ENCODED form.
 * Same frame-minus-headroom arithmetic a download uses, but the number counts
 * escaped bytes — the form the result record actually carries. Pinned to
 * MAX_FRAME_BYTES (src/mobile/secure-channel.ts) by a test alongside the
 * download constants, so raising either side alone fails loudly.
 */
export const ARTIFACT_INLINE_MAX_ESCAPED_BYTES = 128 * 1024 - DOWNLOAD_WRAPPER_HEADROOM_BYTES;

const MIME_BY_KIND: Record<ArtifactKind, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
};

const EXTENSION_BY_KIND: Record<ArtifactKind, string> = {
  markdown: 'md',
  html: 'html',
};

/** Longest basename we will emit; titles are display strings, not filenames. */
const MAX_BASENAME_LENGTH = 80;

export interface ArtifactDownload {
  filename: string;
  mimeType: string;
  /** The version body, base64 (UTF-8). */
  base64: string;
  /** The version this envelope carries, when downloading artifact content. */
  version?: number;
  /** Decoded byte length — of THIS envelope, which may be one slice of a file. */
  size: number;
  /** Where this slice starts in the file. Present only for a sliced fetch. */
  offset?: number;
  /** The whole file's byte length. Present only for a sliced fetch. */
  total?: number;
  /** True when nothing follows this slice. Present only for a sliced fetch. */
  eof?: boolean;
}

/** One window of a file, resolved against its real length. */
export interface SliceWindow {
  offset: number;
  length: number;
  eof: boolean;
}

/**
 * Resolve a caller's `offset`/`length` against a file's real size.
 *
 * WHY THIS EXISTS: a frame carries ~96KiB decoded, but an attachment may be
 * 10MB. Without slicing the only honest answer for a photo is "fetch it on the
 * desktop", which is no answer at all for a phone. Slicing makes the SAME cap
 * a per-request budget instead of a per-file verdict.
 *
 * The rules that matter, and why each is a refusal rather than a silent fix:
 *  - A length past the frame budget is REFUSED, never truncated. Truncating
 *    would hand back fewer bytes than asked with no way to tell that from a
 *    short tail, and a caller looping on `eof` would stop early with a corrupt
 *    file. A cap the caller can see beats one it cannot.
 *  - An offset past the end is NOT an error: a loop that lands exactly on the
 *    boundary asks once more, and answering "nothing, and that was the end" is
 *    the cheapest correct reply.
 */
export function resolveSliceWindow(total: number, offset?: number, length?: number): SliceWindow {
  const from = offset ?? 0;
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`offset must be a non-negative integer, got ${offset}`);
  }
  if (length !== undefined && (!Number.isInteger(length) || length <= 0)) {
    throw new Error(`length must be a positive integer, got ${length}`);
  }
  if (length !== undefined && length > ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES) {
    throw new Error(
      `length ${length} is past the ${ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES}-byte ` +
        'slice budget (the mobile wire frame) — ask for a smaller slice',
    );
  }

  const remaining = Math.max(0, total - from);
  const want = length ?? ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES;
  const size = Math.min(want, remaining);
  return { offset: from, length: size, eof: from + size >= total };
}

/**
 * The inline-read envelope: the artifact's metadata plus exactly ONE version's
 * content. Deliberately NOT the whole versions array — that grows without bound
 * and goes down the same wire frame.
 */
export interface ArtifactRead {
  id: string;
  title: string;
  kind: ArtifactKind;
  versionCount: number;
  createdAt: number;
  updatedAt: number;
  requestedVersion: number;
  requestedVersionContent: string;
}

/**
 * Reduce a display title to a safe cross-platform basename body. Everything a
 * filesystem could misread (control characters, separators, surrounding dots)
 * collapses to a space; a title with nothing left becomes "artifact" so the
 * download still has a usable name.
 */
export function artifactFilename(title: string, kind: ArtifactKind): string {
  const basename = title
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, MAX_BASENAME_LENGTH)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${basename || 'artifact'}.${EXTENSION_BY_KIND[kind]}`;
}

/**
 * Pick the requested version, or the latest. Throws when the version does not
 * exist — a caller-facing answer, not an internal error.
 */
export function selectArtifactVersion(artifact: Artifact, version?: number): { version: number; content: string } {
  const selected = version === undefined
    ? artifact.versions[artifact.versions.length - 1]
    : artifact.versions.find(v => v.version === version);
  if (!selected) {
    throw new Error(`Artifact ${artifact.id} has no version ${version}`);
  }
  return { version: selected.version, content: selected.content };
}

/**
 * Refuse, legibly, a body that cannot ride a frame as a DOWNLOAD. The budget is
 * stated in DECODED bytes because that is the honest number to name in an error
 * and the honest pre-check for base64: 3 bytes become 4 chars, so a body at the
 * decoded cap encodes to exactly the encoded budget — and base64 output is
 * JSON-inert, so nothing inflates it further on the wire. A test pins the
 * "never encodes past the frame" property rather than trusting this arithmetic.
 */
export function assertFitsDownloadBudget(artifact: Artifact, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES) {
    throw new Error(
      `Artifact "${artifact.title}" is ${bytes} bytes, past the ` +
        `${ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES}-byte download cap ` +
        `(${ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES} encoded, the wire frame budget) — ` +
        'fetch it on the desktop instead',
    );
  }
}

/**
 * Refuse, legibly, a body that cannot ride a frame as an INLINE READ. Unlike
 * base64, a plain JSON string is inflated by its own escaping — quotes and
 * backslashes double, control characters cost 6 bytes — so the decoded byte
 * count UNDERSTATES what rides the wire, up to 6x. Hence two checks: the
 * decoded pre-check (escaping never shrinks a body, so a body already past the
 * ceiling needs no stringify to be condemned) and the authoritative measurement
 * of the escaped form, which is exact for every escape class. Together they
 * keep every ACCEPTED read inside the frame that actually carries it.
 */
export function assertFitsInlineReadBudget(artifact: Artifact, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  const reject = (detail: string) =>
    new Error(
      `Artifact "${artifact.title}" ${detail} past the ` +
        `${ARTIFACT_INLINE_MAX_ESCAPED_BYTES}-byte inline cap ` +
        '(JSON escaping counts against the mobile frame budget) — ' +
        'fetch it on the desktop instead',
    );
  if (bytes > ARTIFACT_INLINE_MAX_ESCAPED_BYTES) throw reject(`is ${bytes} bytes`);
  const escapedBytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (escapedBytes > ARTIFACT_INLINE_MAX_ESCAPED_BYTES) {
    throw reject(`is ${bytes} bytes, escaping to ${escapedBytes} bytes of JSON`);
  }
}

/** The download body: base64 (UTF-8), size-checked like every other envelope. */
export function encodeArtifactForWire(artifact: Artifact, content: string): string {
  assertFitsDownloadBudget(artifact, content);
  return Buffer.from(content, 'utf8').toString('base64');
}

/**
 * Build the download envelope for one artifact: its latest version, or the
 * requested one.
 */
export function buildArtifactDownload(artifact: Artifact, version?: number): ArtifactDownload {
  const selected = selectArtifactVersion(artifact, version);
  const base64 = encodeArtifactForWire(artifact, selected.content);
  const size = Buffer.byteLength(selected.content, 'utf8');

  logger.info(`[ArtifactDownload] ${artifact.id} v${selected.version} ${size} bytes`);
  return {
    filename: artifactFilename(artifact.title, artifact.kind),
    mimeType: MIME_BY_KIND[artifact.kind],
    base64,
    version: selected.version,
    size,
  };
}

/**
 * Build the inline-read envelope: metadata plus the ONE version that was asked
 * for (or the latest). Size-checked on the JSON-ESCAPED form, because plain
 * text is exactly the body class the download cap cannot police — escaping can
 * inflate it after these decoded bytes are counted. An empty version body
 * passes — nothing to encode, nothing to burst.
 */
export function buildArtifactRead(artifact: Artifact, version?: number): ArtifactRead {
  const selected = selectArtifactVersion(artifact, version);
  // Plain text, not base64: a read is for RENDERING.
  assertFitsInlineReadBudget(artifact, selected.content);
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    versionCount: artifact.versions.length,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    requestedVersion: selected.version,
    requestedVersionContent: selected.content,
  };
}
