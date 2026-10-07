/**
 * render-artifact — turn MARKDOWN artifact content into a sanitized HTML body.
 *
 * Both artifact kinds are served as their own isolated document over
 * helm-artifact:// (see build-artifact-document.ts and
 * src/electron/helm-artifact-protocol.ts), contained by an opaque origin + CSP.
 * HTML artifacts rely on that alone, so their CSS, SVG and scripts survive
 * intact. Markdown is prose and gets this second layer on top:
 *   markdown → marked (GFM) → DOMPurify.sanitize
 *
 * ```mermaid fenced code blocks are emitted as <pre class="mermaid"> carrying the
 * escaped diagram source; the served document loads the local mermaid bundle
 * and renders those nodes inside the frame.
 *
 * Image rendering:
 *   - Local absolute paths (Windows C:\... or POSIX /...) and file: URIs are
 *     rewritten to helm-img:// so Chromium can serve them without loosening
 *     webSecurity. SVG is intentionally refused (can embed scripts).
 *   - data:image/* (non-svg, case-insensitive) pass through unchanged.
 *   - http/https/data:image/svg+xml/javascript: and anything else → dropped.
 *     Markdown images emit alt text only; HTML <img> nodes are removed.
 */
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ArtifactKind } from '../../src/types/artifact.js';
import { DATA_IMAGE_SAFE, resolveImageSrc } from '../../src/electron/helm-img-protocol.js';
import { ATTACHMENT_LINK_SCHEME } from '../../src/types/artifact-attachment.js';

// Re-exported for the existing render-artifact tests and any renderer caller
// that already imports it from here.
export { resolveImageSrc };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Marked instance
// ---------------------------------------------------------------------------

// A dedicated instance pinned to synchronous mode. We never await rendering, so
// async:false guarantees parse() returns a string; the runtime guard below traps
// any future regression (e.g. a marked upgrade silently returning a Promise)
// rather than letting "[object Promise]" reach the DOM.
const md = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: {
    // ```mermaid → a marker node the served document turns into SVG. All other
    // code blocks fall through to marked's default rendering.
    code({ text, lang }) {
      if ((lang ?? '').trim().toLowerCase() === 'mermaid') {
        return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
      }
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    },

    // Images: resolve src through the safe-src filter. If the src is rejected,
    // render ONLY the escaped alt text so the AI's caption still appears.
    image({ href, text }) {
      const safeSrc = resolveImageSrc(href ?? '');
      if (safeSrc === null) {
        // Dropped: render alt text only so readers still get a meaningful label.
        return escapeHtml(text ?? '');
      }
      return `<img src="${safeSrc}" alt="${escapeHtml(text ?? '')}">`;
    },
  },
});

// ---------------------------------------------------------------------------
// DOMPurify hooks
// ---------------------------------------------------------------------------

// Preserve exactly one class — `mermaid` on a <pre> — so the diagram marker
// survives sanitization; every other class attribute is still stripped. Scoped
// to render-artifact (the only DOMPurify consumer in the renderer).
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class') {
    data.keepAttr = node.nodeName === 'PRE' && data.attrValue === 'mermaid';
    return;
  }

  // Scope helm-img:/data: to <img src> ONLY. ALLOWED_URI_REGEXP has to permit
  // those schemes so images survive, but that regexp is global and would also let
  // them through on <a href> (e.g. `[x](helm-img://…)` / `[x](data:…)`), breaking
  // the href = https/mailto-only invariant. This hook runs BEFORE the regexp check,
  // so dropping them here on any non-IMG element reliably confines them to images.
  if (node.nodeName !== 'IMG' && /^(?:helm-img:|data:)/i.test(data.attrValue)) {
    data.keepAttr = false;
    return;
  }

  // Mirror image of the rule above for the attachment link: it is meaningful
  // only as an <a href> the viewer intercepts, so drop it anywhere else.
  if (data.attrValue.toLowerCase().startsWith(ATTACHMENT_LINK_SCHEME)
    && !(node.nodeName === 'A' && data.attrName === 'href')) {
    data.keepAttr = false;
    return;
  }

  // Rewrite img src for raw-HTML artifacts AND for already-resolved helm-img URLs
  // produced by the marked image renderer (which runs before DOMPurify).
  // If the resolved src is null, drop the attribute — DOMPurify will then remove
  // the entire <img> node because src is required for it to be meaningful, and
  // our allowlist does not include src-less <img> as valid anyway.
  if (data.attrName === 'src' && node.nodeName === 'IMG') {
    const val = data.attrValue;
    // Already a safe resolved value from the marked renderer — pass through.
    if (/^helm-img:/i.test(val) || DATA_IMAGE_SAFE.test(val)) {
      data.keepAttr = true;
      return;
    }
    // Raw-HTML path: run through the resolver.
    const resolved = resolveImageSrc(val);
    if (resolved === null) {
      data.keepAttr = false;
    } else {
      data.attrValue = resolved;
      data.keepAttr = true;
    }
  }
});

// ---------------------------------------------------------------------------
// Sanitizer config
// ---------------------------------------------------------------------------

// Markdown is AI-authored prose. The frame it is served in already keeps it away
// from the app DOM and the preload bridge; this allowlist is the second layer,
// holding the body to what prose needs — lists, tables, code, links, images —
// with no scripts, forms/controls, inline styles or target attributes.
// Links keep their href; the frame reports clicks to ArtifactViewer, which
// decides what opens. The URI allowlist blocks js:/data:/file: on <a>.
// For <img src>, the uponSanitizeAttribute hook above applies the resolveImageSrc
// filter BEFORE DOMPurify sees the value, so helm-img: and safe data: pass through.
const SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
    'blockquote', 'code', 'pre', 'kbd', 'samp', 'var',
    'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'span', 'div',
    'img',
  ],
  // `class` is permitted here but the uponSanitizeAttribute hook narrows it to the
  // single `mermaid` marker on <pre>; every other class value is dropped.
  // `src` is permitted here but the hook rewrites/drops it for <img> above.
  ALLOWED_ATTR: ['href', 'title', 'align', 'colspan', 'rowspan', 'start', 'type', 'class', 'src', 'alt', 'width', 'height'],
  // style/target/srcset forbidden globally; src is rewritten by hook so safe values pass.
  FORBID_ATTR: ['style', 'target', 'srcset'],
  ALLOW_DATA_ATTR: false,
  // <a href> URI allowlist: https/mailto only. img src is controlled by the hook
  // (helm-img: and safe data: are whitelisted there, not here, to avoid loosening
  // the global URI policy for non-img attributes).
  // helm-attachment: is confined to <a href> by the hook above; it is inert
  // markup that ArtifactViewer turns into an artifact:openAttachment call.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|helm-img:|helm-attachment:|data:image\/(?:png|jpe?g|gif|webp|bmp|avif);)/i,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an artifact body to sanitized HTML safe to bind with v-html.
 *
 * @param kind    Content kind: markdown is compiled first, html is passed through.
 * @param content Raw (untrusted) artifact body.
 * @returns Sanitized HTML string restricted to the document allowlist above.
 */
export function renderArtifact(kind: ArtifactKind, content: string, preserveLineBreaks = false): string {
  let raw: string;
  if (kind === 'markdown') {
    const parsed = md.parse(content ?? '', { breaks: preserveLineBreaks });
    if (typeof parsed !== 'string') {
      throw new Error('[render-artifact] marked returned a Promise; expected synchronous output');
    }
    raw = parsed;
  } else {
    raw = content ?? '';
  }
  return DOMPurify.sanitize(raw, SANITIZE_OPTIONS);
}
