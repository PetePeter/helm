/**
 * helm-img:// Custom Protocol — serves local image files to the renderer.
 *
 * With contextIsolation:true and webSecurity:ON, `<img src="file:///C:\...">` is
 * blocked by Chromium's mixed-content/same-origin rules. This custom privileged
 * scheme sidesteps that without loosening webSecurity or file:// access.
 *
 * SVG is intentionally NOT served: SVG can contain scripts, and serving it via a
 * privileged scheme with the Helm preload attached would be a security risk.
 */

// ---------------------------------------------------------------------------
// URL encoding/decoding helpers
// ---------------------------------------------------------------------------

/**
 * Encodes an absolute local path into a helm-img:// URL.
 *
 * The path goes in the `p` QUERY parameter behind a fixed host `f` — NOT in the
 * authority. Because `standard: true`, Chromium normalizes and case-folds the
 * URL authority before the live protocol handler sees it, which would corrupt a
 * path stored in the host. Query values are left untouched, so this survives
 * round-tripping through the real Chromium URL parser with case intact.
 */
export function encodeHelmImgUrl(absPath: string): string {
  return `helm-img://f/?p=${encodeURIComponent(absPath)}`;
}

/**
 * Decodes a helm-img:// URL back to the original absolute path.
 *
 * Reads the `p` query parameter (searchParams.get already percent-decodes, so we
 * must NOT decode again). Robust against Chromium case-folding the authority.
 * Round-trips: decodeHelmImgUrl(encodeHelmImgUrl(p)) === p. Returns '' if `p` is
 * absent so the handler can respond with a graceful 404.
 */
export function decodeHelmImgUrl(url: string): string {
  const p = new URL(url).searchParams.get('p');
  return p === null ? '' : p;
}

// ---------------------------------------------------------------------------
// Image source resolution
// ---------------------------------------------------------------------------

// Safe non-svg data: image types — mirrors EXT_TO_MIME below, minus SVG.
export const DATA_IMAGE_SAFE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);/i;

/**
 * Decides what src value (if any) an <img> pointing at a local file should carry.
 *
 * Lives here, next to encodeHelmImgUrl, because both the markdown sanitizer and
 * the HTML document builder need it and neither should own a second copy of the
 * path rules. Pure and DOM-free, so it is safe to import from either process.
 *
 * Rules (in order):
 *   1. Local absolute path — Windows drive (C:\), UNC (\\), or POSIX (/) →
 *      encoded as helm-img:// so Chromium serves it via the privileged protocol.
 *   2. file: URI → extract the path and treat as (1).
 *   3. data:image/<safe-type> (non-svg) → pass through unchanged.
 *   4. Everything else (http/https, data:image/svg+xml, javascript:, …) → null.
 *
 * @returns The safe src to use, or null when the caller should suppress or
 *          leave the original value for a CSP to reject.
 */
export function resolveImageSrc(rawSrc: string): string | null {
  if (!rawSrc) return null;

  // file: URI → strip scheme, use the raw path component
  if (/^file:/i.test(rawSrc)) {
    // file:///C:/a/i.png → C:/a/i.png  (Windows: strip leading slash after authority)
    // file:///home/u/f.png → /home/u/f.png  (POSIX: keep leading slash)
    const withoutScheme = rawSrc.replace(/^file:\/\//i, '');
    const path = /^\/[a-zA-Z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
    return encodeHelmImgUrl(path);
  }

  // Windows absolute path: C:\, D:/, \\server\share
  if (/^[a-zA-Z]:[/\\]/.test(rawSrc) || /^\\\\/.test(rawSrc)) {
    return encodeHelmImgUrl(rawSrc);
  }

  // POSIX absolute path
  if (rawSrc.startsWith('/')) {
    return encodeHelmImgUrl(rawSrc);
  }

  // Safe data: image (non-svg)
  if (DATA_IMAGE_SAFE.test(rawSrc)) {
    return rawSrc;
  }

  // Everything else: http/https, data:image/svg+xml, javascript:, relative, garbage
  return null;
}

// ---------------------------------------------------------------------------
// MIME resolution
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Returns the MIME type for a given path, or null if the format is refused.
 *
 * SVG returns null (intentionally refused — SVG can embed scripts and must
 * not be served via a privileged scheme). Unknown extensions return
 * 'application/octet-stream'.
 */
export function mimeForPath(filePath: string): string | null {
  const leaf = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = leaf.lastIndexOf('.');
  const ext = dot >= 0 ? leaf.slice(dot).toLowerCase() : '';
  if (ext === '.svg') return null;
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parse one byte range; null means unsatisfiable or unsupported. */
export function parseByteRange(value: string, size: number): ByteRange | null {
  if (size <= 0 || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}
