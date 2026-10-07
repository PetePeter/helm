/**
 * build-artifact-document — wrap an AI-authored artifact (HTML or markdown)
 * into a complete document to be served over helm-artifact://.
 *
 * Containment for both kinds comes from the opaque origin and the CSP response
 * header set by the protocol handler (see src/electron/helm-artifact-protocol.ts),
 * plus the iframe sandbox attribute. HTML artifacts are therefore left intact:
 * they keep their <style>, inline styles, classes, SVG and scripts. Markdown is
 * additionally sanitized (render-artifact.ts) because prose has no business
 * running script.
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
import { renderArtifact } from './render-artifact.js';

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
 * do nothing. The parent decides what a reported URL may do (open https
 * externally, open an attachment); this side only reports it.
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
 * Turns the `<pre class="mermaid">` markers of a markdown document into
 * diagrams, one at a time, each under its own id.
 *
 * Why not mermaid.run(): it names diagrams `mermaid-<Date.now()>`, so two
 * rendered in the same millisecond share an id. Mermaid scopes each diagram's
 * styles by that id (edges `fill:none`, label colours), so the duplicate draws
 * arrows as filled triangles and text dark-on-dark. A diagram that does not
 * parse keeps its source and says so, rather than passing for code.
 */
export const MERMAID_RENDER_SCRIPT = `
(async function () {
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
  var nodes = document.querySelectorAll('pre.mermaid');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    try {
      node.innerHTML = (await mermaid.render('helm-mermaid-' + (i + 1), node.textContent || '')).svg;
    } catch (err) {
      console.error('[mermaid] render failed', err);
      node.classList.add('mermaid-failed');
      var note = document.createElement('div');
      note.className = 'mermaid-fail-note';
      note.textContent = '\\u26A0 Diagram could not be rendered \\u2014 see source above';
      node.append(note);
    }
  }
})();
`.trim();

function appendScript(doc: Document, init: { src?: string; text?: string }): void {
  const script = doc.createElement('script');
  if (init.src) script.setAttribute('src', init.src);
  if (init.text) script.textContent = init.text;
  doc.body.append(script);
}

function injectBaseCss(doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = ARTIFACT_BASE_CSS;
  doc.head.prepend(style);
}

/** The link bridge goes last, so its ready ping means the document is alive. */
function serialize(doc: Document): string {
  appendScript(doc, { text: LINK_BRIDGE_SCRIPT });
  return `<!doctype html>${doc.documentElement.outerHTML}`;
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
  if (!hasAuthorStyling(doc)) injectBaseCss(doc);

  return serialize(doc);
}

/**
 * Build the full document to serve for a MARKDOWN artifact.
 *
 * Markdown is served through the same isolated frame as HTML, but it is prose:
 * the body is still sanitized against the document allow-list, so the only
 * scripts in the document are the ones injected here. It cannot style itself
 * either, so the base stylesheet is unconditional.
 *
 * @param markdown Raw (untrusted) artifact body.
 * @param preserveLineBreaks Treat single newlines as line breaks (manual notes).
 * @returns A complete `<!doctype html>` string.
 */
export function buildMarkdownDocument(markdown: string, preserveLineBreaks = false): string {
  const body = renderArtifact('markdown', markdown, preserveLineBreaks);
  const doc = new DOMParser().parseFromString(body, 'text/html');

  injectBaseCss(doc);
  if (doc.querySelector('pre.mermaid')) {
    appendScript(doc, { src: MERMAID_ASSET_URL });
    appendScript(doc, { text: MERMAID_RENDER_SCRIPT });
  }

  return serialize(doc);
}
