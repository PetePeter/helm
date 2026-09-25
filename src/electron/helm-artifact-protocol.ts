/**
 * helm-artifact:// Custom Protocol — serves one AI-authored HTML artifact
 * document to an isolated iframe.
 *
 * WHY A CUSTOM SCHEME RATHER THAN `<iframe srcdoc>`:
 * Documents with a *local scheme* (about:srcdoc, about:blank, blob:, data:)
 * inherit the CSP of the embedding document, and that inherited policy applies
 * IN ADDITION to anything the frame declares — the intersection wins, and W3C
 * closed the request to opt out (webappsec-csp#700) as wontfix. The renderer's
 * policy is `script-src 'self'`, so a srcdoc frame would silently refuse to run
 * the artifact's inline scripts and would block helm-img: images.
 *
 * A document fetched over a real scheme via `src` does not inherit, and can
 * carry an authoritative Content-Security-Policy RESPONSE header that artifact
 * script cannot strip. Electron also gives custom-protocol iframes origin
 * "null" (electron#40663) — the opaque origin we want, for free.
 *
 * Containment therefore comes from origin isolation + the CSP below + the
 * iframe sandbox attribute, rather than from the DOMPurify tag allow-list that
 * still guards the markdown path (renderer/artifacts/render-artifact.ts).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Protocol } from 'electron';

/** URL artifact documents use to load the locally-bundled mermaid. */
export const MERMAID_ASSET_URL = 'helm-artifact://asset/mermaid.js';

/**
 * The policy every artifact document is served under.
 *
 * `script-src 'unsafe-inline'` carries NO 'self' and no host source: the
 * artifact's own inline <script> runs, but no external script can be loaded.
 * The single exception is the `helm-artifact:` scheme itself, so the locally
 * bundled mermaid (MERMAID_ASSET_URL) loads with zero network egress.
 * With `default-src 'none'` there is no network egress at all — no CDN, no
 * fetch, no web fonts, no remote images. Local images arrive via helm-img://.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  'img-src helm-img: data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "script-src 'unsafe-inline' helm-artifact:",
  "form-action 'none'",
  "base-uri 'none'",
  // The embedding Helm renderer is loaded from file://, not helm-artifact://.
  // Keep same-origin framing allowed while explicitly permitting Helm's local
  // privileged windows to embed the isolated artifact document.
  "frame-ancestors 'self' file:",
].join('; ');

/** Builds the iframe src for a nonce handed back by {@link setPendingDocument}. */
export function encodeHelmArtifactUrl(nonce: string): string {
  return `helm-artifact://doc/?k=${encodeURIComponent(nonce)}`;
}

// ---------------------------------------------------------------------------
// Pending documents
// ---------------------------------------------------------------------------

// Preparing an iframe document is asynchronous across the renderer/main
// boundary. A single slot let a later selection evict a frame whose navigation
// had not started yet, leaving a perfectly valid artifact blank with a 404.
// Keep a deliberately small, insertion-ordered cache instead. This preserves
// isolation while allowing rapid selection changes and more than one viewer.
export const MAX_PENDING_DOCUMENTS = 32;
const pendingDocuments = new Map<string, string>();

/**
 * Stores a document to be served and returns its opaque nonce.
 * The cache is bounded, so stale documents cannot accumulate indefinitely.
 */
export function setPendingDocument(html: string): string {
  const nonce = randomUUID();
  if (pendingDocuments.size >= MAX_PENDING_DOCUMENTS) {
    const oldestNonce = pendingDocuments.keys().next().value;
    if (oldestNonce) pendingDocuments.delete(oldestNonce);
  }
  pendingDocuments.set(nonce, html);
  return nonce;
}

// ---------------------------------------------------------------------------
// Protocol handler
// ---------------------------------------------------------------------------

/**
 * Registers the helm-artifact:// handler. Must be called AFTER app is ready.
 *
 * Call protocol.registerSchemesAsPrivileged() BEFORE app is ready with
 * { standard:true, secure:true } — deliberately NOT bypassCSP, since the whole
 * point is that the CSP above is enforced.
 *
 * `mermaidAssetPath` points at the build-copied mermaid bundle
 * (dist-electron/assets/mermaid.min.js); without it the asset route 404s and
 * artifacts simply keep failing as before, so the doc path is unaffected.
 *
 * The protocol adapter is injected so this module stays unit-testable without a
 * runtime Electron dependency.
 */
export function registerHelmArtifactProtocol(
  protocol: Pick<Protocol, 'handle'>,
  mermaidAssetPath?: string,
): void {
  // Cached per registration (not module scope) so a re-registration — or a
  // test with a different path — never serves a stale bundle.
  let mermaidAssetBytes: Buffer | null = null;

  protocol.handle('helm-artifact', async (request) => {
    const url = new URL(request.url);

    // The one non-document route: the locally-bundled mermaid script.
    if (url.host === 'asset' && url.pathname === '/mermaid.js') {
      if (!mermaidAssetPath) return new Response('No mermaid asset configured', { status: 404 });
      try {
        mermaidAssetBytes ??= readFileSync(mermaidAssetPath);
      } catch {
        return new Response('Mermaid asset not found', { status: 404 });
      }
      return new Response(mermaidAssetBytes, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          // The bundle is Helm-owned and immutable per launch — cache freely.
          'Cache-Control': 'max-age=3600',
        },
      });
    }

    const nonce = url.searchParams.get('k');
    const html = nonce ? pendingDocuments.get(nonce) : undefined;
    if (!nonce || html === undefined) {
      return new Response('No such artifact document', { status: 404 });
    }
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': ARTIFACT_CSP,
      },
    });
  });
}
