// @vitest-environment jsdom
/**
 * render-artifact sanitization tests — the artifact HTML is AI-authored and lands
 * in the privileged Electron window via v-html, so these lock down the allowlist:
 * safe prose/tables/links survive; scripts, forms, media, inline styles, and
 * unsafe URL schemes do not.
 */
import { describe, it, expect } from 'vitest';
import { renderArtifact, resolveImageSrc } from '../renderer/artifacts/render-artifact.js';

// ---------------------------------------------------------------------------
// resolveImageSrc unit tests
// ---------------------------------------------------------------------------

describe('resolveImageSrc', () => {
  it('converts Windows absolute path to helm-img URL', () => {
    const result = resolveImageSrc('C:\\a\\img.png');
    expect(result).toBe(`helm-img://f/?p=${encodeURIComponent('C:\\a\\img.png')}`);
  });

  it('converts POSIX absolute path to helm-img URL', () => {
    const result = resolveImageSrc('/home/u/i.png');
    expect(result).toBe(`helm-img://f/?p=${encodeURIComponent('/home/u/i.png')}`);
  });

  it('converts file: URI to helm-img URL', () => {
    const result = resolveImageSrc('file:///C:/a/i.png');
    expect(result).toBe(`helm-img://f/?p=${encodeURIComponent('C:/a/i.png')}`);
  });

  it('passes through data:image/png (non-svg)', () => {
    const src = 'data:image/png;base64,AAA';
    expect(resolveImageSrc(src)).toBe(src);
  });

  it('passes through data:image/jpeg', () => {
    const src = 'data:image/jpeg;base64,AAA';
    expect(resolveImageSrc(src)).toBe(src);
  });

  it('passes through data:image/gif', () => {
    const src = 'data:image/gif;base64,AAA';
    expect(resolveImageSrc(src)).toBe(src);
  });

  it('passes through data:image/webp', () => {
    const src = 'data:image/webp;base64,AAA';
    expect(resolveImageSrc(src)).toBe(src);
  });

  it('passes through data:image/avif', () => {
    const src = 'data:image/avif;base64,AAA';
    expect(resolveImageSrc(src)).toBe(src);
  });

  it('blocks data:image/svg+xml', () => {
    expect(resolveImageSrc('data:image/svg+xml,<svg>')).toBeNull();
  });

  it('blocks data:text/html', () => {
    expect(resolveImageSrc('data:text/html,x')).toBeNull();
  });

  it('blocks http URL', () => {
    expect(resolveImageSrc('http://x/i.png')).toBeNull();
  });

  it('blocks https URL', () => {
    expect(resolveImageSrc('https://x/i.png')).toBeNull();
  });

  it('blocks javascript: scheme', () => {
    expect(resolveImageSrc('javascript:alert(1)')).toBeNull();
  });

  it('blocks empty string', () => {
    expect(resolveImageSrc('')).toBeNull();
  });

  it('blocks plain non-URL garbage', () => {
    expect(resolveImageSrc('not a url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderArtifact integration tests — images
// ---------------------------------------------------------------------------

describe('renderArtifact — image rendering', () => {
  it('markdown local Windows path (forward slashes) renders as helm-img <img>', () => {
    // Markdown uses forward slashes even on Windows; backslash is a markdown escape char.
    const out = renderArtifact('markdown', '![desc](C:/out/d.png)');
    expect(out).toContain('<img');
    expect(out).toContain('helm-img://');
    expect(out).toContain('alt="desc"');
    // raw path must not appear in src
    expect(out).not.toContain('src="C:');
  });

  it('markdown data:image/png renders as <img>', () => {
    const src = 'data:image/png;base64,AAA';
    const out = renderArtifact('markdown', `![pic](${src})`);
    expect(out).toContain('<img');
    expect(out).toContain(src);
  });

  it('markdown https image is dropped — alt text only, no <img src>', () => {
    const out = renderArtifact('markdown', '![remote](https://example.com/img.png)');
    expect(out).toContain('remote');
    expect(out.toLowerCase()).not.toContain('<img');
  });

  it('html-kind <img src="local path"> is rewritten to helm-img', () => {
    const out = renderArtifact('html', '<img src="C:\\x.png" alt="test">');
    expect(out).toContain('<img');
    expect(out).toContain('helm-img://');
  });

  it('html-kind <img src="https://..."> is dropped', () => {
    const out = renderArtifact('html', '<img src="https://evil/track.png" alt="x">');
    expect(out.toLowerCase()).not.toContain('https://evil');
  });
});

// ---------------------------------------------------------------------------
// href scheme lockdown — helm-img:/data: must NEVER survive on <a href>, only
// on <img src>. Widening ALLOWED_URI_REGEXP to allow those schemes for images
// would otherwise leak them onto anchors; the hook scopes them to IMG only.
// ---------------------------------------------------------------------------

describe('renderArtifact — anchor href scheme lockdown', () => {
  it('drops helm-img: on html <a href>', () => {
    const out = renderArtifact('html', '<a href="helm-img://f/?p=C:\\secret.txt">x</a>');
    expect(out.toLowerCase()).not.toContain('helm-img:');
  });

  it('drops helm-img: on a markdown link', () => {
    const out = renderArtifact('markdown', '[x](helm-img://f/?p=C:\\secret.txt)');
    expect(out.toLowerCase()).not.toContain('helm-img:');
  });

  it('drops data: on html <a href>', () => {
    const out = renderArtifact('html', '<a href="data:image/png;base64,AAA">x</a>');
    expect(out.toLowerCase()).not.toContain('data:');
  });

  it('still preserves a normal https <a href>', () => {
    const out = renderArtifact('html', '<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('still rewrites a valid <img src> local path to helm-img', () => {
    const out = renderArtifact('html', '<img src="C:\\x.png" alt="test">');
    expect(out).toContain('helm-img://');
  });
});

// ---------------------------------------------------------------------------
// Regression tests (must still pass)
// ---------------------------------------------------------------------------

describe('renderArtifact', () => {
  it('renders a compact artifact as markdown', () => {
    expect(renderArtifact('compact', '# Snap')).toContain('<h1');
  });

  it('preserves single newlines in pasted plain text', () => {
    const out = renderArtifact('markdown', 'first line\nsecond line', true);
    expect(out).toContain('first line<br>second line');
  });

  it('does not force breaks in ordinary markdown by default', () => {
    const out = renderArtifact('markdown', 'first line\nsecond line');
    expect(out).toContain('first line\nsecond line');
    expect(out).not.toContain('<br>');
  });

  it('renders safe markdown (headings, tables, code)', () => {
    const out = renderArtifact('markdown', '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`code`');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<table>');
    expect(out).toContain('<code>code</code>');
  });

  it('preserves a safe https link', () => {
    const out = renderArtifact('html', '<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('strips <script>', () => {
    const out = renderArtifact('html', '<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('ok');
    expect(out.toLowerCase()).not.toContain('<script');
  });

  it('strips forms and controls', () => {
    const out = renderArtifact('html', '<form action="https://evil"><input name="p"><button>go</button></form>');
    expect(out.toLowerCase()).not.toContain('<form');
    expect(out.toLowerCase()).not.toContain('<input');
    expect(out.toLowerCase()).not.toContain('<button');
  });

  it('strips inline styles (no position:fixed overlay spoofing)', () => {
    const out = renderArtifact('html', '<p style="position:fixed;inset:0">x</p>');
    expect(out).toContain('x');
    expect(out.toLowerCase()).not.toContain('style=');
    expect(out.toLowerCase()).not.toContain('position');
  });

  it('strips external <video>', () => {
    const out = renderArtifact('html', '<video src="http://evil/v"></video>');
    expect(out.toLowerCase()).not.toContain('<video');
  });

  it('drops javascript: and file: hrefs', () => {
    const js = renderArtifact('html', '<a href="javascript:alert(1)">x</a>');
    expect(js.toLowerCase()).not.toContain('javascript:');
    const file = renderArtifact('markdown', '[x](file:///etc/passwd)');
    expect(file.toLowerCase()).not.toContain('file:');
  });

  it('strips target attributes (no _blank window opens)', () => {
    const out = renderArtifact('html', '<a href="https://example.com" target="_blank">x</a>');
    expect(out.toLowerCase()).not.toContain('target=');
  });

  it('emits a mermaid marker for ```mermaid fences (source escaped)', () => {
    const out = renderArtifact('markdown', '```mermaid\ngraph TD; A-->B;\n```');
    expect(out).toContain('<pre class="mermaid">');
    expect(out).toContain('graph TD; A--&gt;B;');
  });

  it('keeps class only for the mermaid marker on <pre>, strips it elsewhere', () => {
    const p = renderArtifact('html', '<p class="modal-overlay">x</p>');
    expect(p.toLowerCase()).not.toContain('class=');
    const div = renderArtifact('html', '<div class="mermaid">x</div>');
    expect(div.toLowerCase()).not.toContain('class='); // mermaid class only allowed on <pre>
  });
});
