/**
 * build-artifact-document — wrap an AI-authored HTML artifact into a complete
 * document to be served over helm-artifact://.
 *
 * Unlike the markdown path, nothing here strips tags. HTML artifacts keep their
 * <style>, inline styles, classes, SVG and scripts; containment comes from the
 * opaque origin and the CSP response header set by the protocol handler (see
 * src/electron/helm-artifact-protocol.ts), plus the iframe sandbox attribute.
 *
 * This runs in the renderer because that is where DOMParser lives. Parsing is
 * inert — DOMParser neither executes scripts nor fetches resources — and it
 * normalises bare fragments and full documents to the same shape, which is far
 * safer than string surgery over untrusted markup.
 *
 * No CSP <meta> is injected: the response header is authoritative and, unlike a
 * meta tag, is not part of the document artifact script can reach.
 */

import { resolveImageSrc } from '../../src/electron/helm-img-protocol.js';
import { MERMAID_ASSET_URL } from '../../src/electron/helm-artifact-protocol.js';
import { ARTIFACT_BASE_CSS } from './artifact-base-css.js';

/**
 * Message type the frame posts to the parent when a link is clicked.
 * Kept in one place so the injected script and the ArtifactViewer listener
 * cannot drift apart.
 */
export const OPEN_URL_MESSAGE = 'helm-artifact-open-url';

/**
 * Message the frame posts once its document is alive. The parent uses its
 * ABSENCE as the signal that the artifact could not render — a document whose
 * own CSP kills our injected script, or one that never loads, stays silently
 * blank otherwise, with no error event to hook.
 */
export const READY_MESSAGE = 'helm-artifact-ready';

/**
 * Links inside the frame are inert by design — the sandbox blocks navigation
 * and `default-src 'none'` blocks loads — so without this they would silently
 * do nothing, unlike the markdown path which routes https? through
 * shell.openExternal. The parent validates the URL; this side only reports it.
 */
const LINK_BRIDGE_SCRIPT = `
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  e.preventDefault();
  parent.postMessage({ type: '${OPEN_URL_MESSAGE}', url: a.href }, '*');
}, true);
parent.postMessage({ type: '${READY_MESSAGE}' }, '*');
`.trim();

/** True when the author styled the document in any way at all. */
function hasAuthorStyling(doc: Document): boolean {
  return (
    doc.querySelector('style') !== null ||
    doc.querySelector('link[rel~="stylesheet" i]') !== null ||
    doc.querySelector('[style]') !== null
  );
}

/**
 * Rewrites local-file image sources to helm-img:// so Chromium can serve them.
 * Anything the resolver rejects (http/https, svg data URIs, …) is left as-is —
 * the CSP `img-src helm-img: data:` is what refuses it, so there is no second
 * policy here to keep in sync.
 */
function rewriteImages(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const resolved = resolveImageSrc(img.getAttribute('src') ?? '');
    if (resolved !== null) img.setAttribute('src', resolved);
  }
}

/**
 * A remote script src is a mermaid bundle when its path's last segment starts
 * with "mermaid" (covers mermaid.min.js, mermaid@11/…, mermaid.esm.min.mjs).
 * Used to retarget CDN diagrams at the locally-served copy.
 */
function isMermaidScriptSrc(src: string): boolean {
  try {
    const last = new URL(src).pathname.split('/').filter(Boolean).pop() ?? '';
    return last.toLowerCase().startsWith('mermaid');
  } catch {
    return false;
  }
}

/**
 * The artifact CSP has no network egress, so the near-universal pattern of
 * `<script src="https://cdn…/mermaid.min.js">` renders nothing (and consoles a
 * CSP refusal). Point mermaid references at the bundled local copy instead;
 * every other remote script stays untouched and stays blocked.
 */
function rewriteMermaidScripts(doc: Document): void {
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const src = script.getAttribute('src') ?? '';
    if (/^https?:/i.test(src) && isMermaidScriptSrc(src)) {
      script.setAttribute('src', MERMAID_ASSET_URL);
    }
  }
}

/**
 * Build the full document to serve for an HTML artifact.
 *
 * @param html Raw (untrusted) artifact body — a fragment or a full document.
 * @returns A complete `<!doctype html>` string.
 */
export function buildArtifactDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html ?? '', 'text/html');

  rewriteImages(doc);
  rewriteMermaidScripts(doc);

  if (!hasAuthorStyling(doc)) {
    const style = doc.createElement('style');
    style.textContent = ARTIFACT_BASE_CSS;
    doc.head.prepend(style);
  }

  const bridge = doc.createElement('script');
  bridge.textContent = LINK_BRIDGE_SCRIPT;
  doc.body.append(bridge);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
