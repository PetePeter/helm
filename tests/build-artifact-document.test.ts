// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildArtifactDocument, READY_MESSAGE } from '../renderer/artifacts/build-artifact-document.js';
import { ARTIFACT_BASE_CSS } from '../renderer/artifacts/artifact-base-css.js';

/** A marker unique enough that a substring match proves the base CSS was injected. */
const BASE_CSS_MARKER = ARTIFACT_BASE_CSS.slice(0, 40);

describe('buildArtifactDocument — author fidelity', () => {
  // These five are the bug being fixed: the DOMPurify path strips every one of
  // them, which is why AI-authored HTML arrives as unstyled prose.

  it('preserves a <style> block verbatim', () => {
    const out = buildArtifactDocument('<style>.card{display:grid;gap:8px}</style><div class="card">x</div>');
    expect(out).toContain('.card{display:grid;gap:8px}');
  });

  it('preserves inline style attributes', () => {
    const out = buildArtifactDocument('<p style="color:tomato;font-weight:700">hi</p>');
    expect(out).toContain('style="color:tomato;font-weight:700"');
  });

  it('preserves class attributes', () => {
    const out = buildArtifactDocument('<div class="grid wide">x</div>');
    expect(out).toContain('class="grid wide"');
  });

  it('preserves inline <svg>', () => {
    const out = buildArtifactDocument('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
    expect(out).toContain('<svg');
    expect(out).toContain('<circle');
  });

  // The tripwire for the srcdoc trap. A local-scheme document (about:srcdoc,
  // blob:, data:) INHERITS the embedding page's CSP — and this app's renderer
  // CSP is `script-src 'self'`, so inline artifact scripts would silently never
  // run. The document is therefore served over helm-artifact:// via `src`, which
  // does not inherit and carries its own CSP response header. If this ever gets
  // "simplified" back to srcdoc, every other test here still passes and only
  // this one plus the manual check will catch it.
  it('preserves <script> bodies verbatim', () => {
    const out = buildArtifactDocument('<script>document.title="ran"</script>');
    expect(out).toContain('document.title="ran"');
  });
});

describe('buildArtifactDocument — fallback styling', () => {
  it('injects the base stylesheet when the artifact brings no styling', () => {
    expect(buildArtifactDocument('<h1>Report</h1><p>body</p>')).toContain(BASE_CSS_MARKER);
  });

  // "Artifact decides, app provides fallback" — any sign the author styled the
  // document at all means we keep our hands off it entirely.
  const styledCases: Array<[string, string]> = [
    ['a <style> block', '<style>body{background:#fff}</style><p>x</p>'],
    ['an inline style attribute', '<p style="color:red">x</p>'],
    ['a stylesheet <link>', '<link rel="stylesheet" href="theme.css"><p>x</p>'],
  ];

  for (const [label, html] of styledCases) {
    it(`does not inject the base stylesheet when the artifact has ${label}`, () => {
      expect(buildArtifactDocument(html)).not.toContain(BASE_CSS_MARKER);
    });
  }
});

describe('buildArtifactDocument — local images', () => {
  // Table-driven across both platforms so this suite is identical on macOS and
  // Windows. Never assert on a path separator.
  const localPaths: Array<[string, string]> = [
    ['POSIX', '/Users/x/a.png'],
    ['Windows drive', 'C:\\x\\a.png'],
  ];

  for (const [label, path] of localPaths) {
    it(`rewrites a ${label} image src to helm-img://`, () => {
      const out = buildArtifactDocument(`<img src="${path.replace(/\\/g, '&#92;')}" alt="a">`);
      expect(out).toContain('helm-img://');
      expect(out).not.toContain(`src="${path}"`);
    });
  }

  it('rewrites a Windows path supplied as a raw attribute value', () => {
    const out = buildArtifactDocument('<img src="C:\\x\\a.png" alt="a">');
    expect(out).toContain('helm-img://');
  });

  // Remote images are left alone; the CSP (img-src helm-img: data:) is what
  // stops them loading, so there is no second place to keep in sync.
  it('leaves a remote image src untouched', () => {
    const out = buildArtifactDocument('<img src="https://example.com/a.png">');
    expect(out).toContain('https://example.com/a.png');
  });
});

describe('buildArtifactDocument — document shape', () => {
  const shapes: Array<[string, string]> = [
    ['a bare fragment', '<p>hello</p>'],
    ['a full document', '<!doctype html><html><head><title>T</title></head><body><p>hello</p></body></html>'],
  ];

  for (const [label, html] of shapes) {
    it(`normalises ${label} into a single well-formed document`, () => {
      const out = buildArtifactDocument(html);
      expect(out.startsWith('<!doctype html>')).toBe(true);
      expect(out.match(/<html/gi)?.length).toBe(1);
      expect(out.match(/<body/gi)?.length).toBe(1);
      expect(out).toContain('hello');
    });
  }

  it('injects the link bridge so anchors still open externally', () => {
    const out = buildArtifactDocument('<a href="https://example.com">go</a>');
    expect(out).toContain('helm-artifact-open-url');
  });

  // The viewer treats a missing ready ping as "this document did not render"
  // and offers Open externally instead, so the ping must always be emitted.
  it('injects the ready ping the viewer waits for', () => {
    const out = buildArtifactDocument('<p>hello</p>');
    expect(out).toContain(READY_MESSAGE);
  });
});

describe('buildArtifactDocument — mermaid CDN rewrite', () => {
  const CDN_SRCS = [
    'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
    'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js',
    'https://unpkg.com/mermaid@12.0.0/dist/mermaid.min.js',
  ];

  for (const src of CDN_SRCS) {
    it(`rewrites ${new URL(src).host} mermaid to the local asset`, () => {
      const out = buildArtifactDocument(`<script src="${src}"></script><div class="mermaid">graph TD; A-->B</div>`);
      expect(out).toContain('src="helm-artifact://asset/mermaid.js"');
      expect(out).not.toContain(src);
    });
  }

  it('leaves non-mermaid remote scripts untouched (the CSP still blocks them)', () => {
    const out = buildArtifactDocument('<script src="https://cdn.example.com/chart.js"></script>');
    expect(out).toContain('https://cdn.example.com/chart.js');
    expect(out).not.toContain('helm-artifact://asset/mermaid.js');
  });

  it('leaves relative and already-local script srcs alone', () => {
    const out = buildArtifactDocument('<script src="./local.js"></script>');
    expect(out).toContain('./local.js');
  });
});
