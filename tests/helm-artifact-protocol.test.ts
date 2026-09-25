import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_CSP,
  MAX_PENDING_DOCUMENTS,
  MERMAID_ASSET_URL,
  encodeHelmArtifactUrl,
  setPendingDocument,
  registerHelmArtifactProtocol,
} from '../src/electron/helm-artifact-protocol.js';

/**
 * Captures the handler `registerHelmArtifactProtocol` installs so tests can
 * invoke it directly with a plain { url } request — no Electron needed.
 */
function captureHandler(mermaidAssetPath?: string): (req: { url: string }) => Promise<Response> {
  let captured: ((req: { url: string }) => Promise<Response>) | null = null;
  registerHelmArtifactProtocol({
    handle: (_scheme: string, handler: (req: never) => unknown) => {
      captured = handler as (req: { url: string }) => Promise<Response>;
    },
  } as never, mermaidAssetPath);
  if (!captured) throw new Error('handler was not registered');
  return captured;
}

describe('helm-artifact:// protocol', () => {
  it('serves the stored document as text/html with the artifact CSP header', async () => {
    const handle = captureHandler();
    const nonce = setPendingDocument('<!doctype html><html><body>hi</body></html>');

    const res = await handle({ url: encodeHelmArtifactUrl(nonce) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP);
    expect(await res.text()).toContain('hi');
  });

  it('404s an unknown nonce', async () => {
    const handle = captureHandler();
    setPendingDocument('<p>doc</p>');

    const res = await handle({ url: encodeHelmArtifactUrl('not-a-real-nonce') });

    expect(res.status).toBe(404);
  });

  it('404s when the k query param is missing', async () => {
    const handle = captureHandler();
    setPendingDocument('<p>doc</p>');

    const res = await handle({ url: 'helm-artifact://doc/' });

    expect(res.status).toBe(404);
  });

  it('keeps rapid consecutive documents reachable by their own nonce', async () => {
    const handle = captureHandler();
    const first = setPendingDocument('<p>first</p>');
    const second = setPendingDocument('<p>second</p>');

    expect(await (await handle({ url: encodeHelmArtifactUrl(first) })).text()).toContain('first');
    expect(await (await handle({ url: encodeHelmArtifactUrl(second) })).text()).toContain('second');
  });

  it('mints a distinct nonce per document', () => {
    expect(setPendingDocument('<p>a</p>')).not.toBe(setPendingDocument('<p>a</p>'));
  });

  it('bounds retained documents by evicting the oldest nonce', async () => {
    const handle = captureHandler();
    const first = setPendingDocument('<p>oldest</p>');
    for (let index = 0; index < MAX_PENDING_DOCUMENTS; index++) {
      setPendingDocument(`<p>${index}</p>`);
    }
    expect((await handle({ url: encodeHelmArtifactUrl(first) })).status).toBe(404);
  });

  describe('mermaid asset route', () => {
    let assetDir: string;

    afterEach(() => {
      if (assetDir) rmSync(assetDir, { recursive: true, force: true });
    });

    it('serves the configured bundle with a JS content type and no CSP header', async () => {
      assetDir = join(tmpdir(), `helm-test-mermaid-asset-${randomUUID()}`);
      mkdirSync(assetDir, { recursive: true });
      const assetPath = join(assetDir, 'mermaid.min.js');
      writeFileSync(assetPath, 'export {} // fake mermaid bundle');

      const handle = captureHandler(assetPath);
      const res = await handle({ url: MERMAID_ASSET_URL });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
      expect(res.headers.get('Content-Security-Policy')).toBeNull();
      expect(await res.text()).toContain('fake mermaid bundle');
    });

    it('404s the asset when no bundle path is configured or the file is gone', async () => {
      const unconfigured = await captureHandler()({ url: MERMAID_ASSET_URL });
      expect(unconfigured.status).toBe(404);

      const handle = captureHandler(join(tmpdir(), `does-not-exist-${randomUUID()}.js`));
      const missing = await handle({ url: MERMAID_ASSET_URL });
      expect(missing.status).toBe(404);
    });

    it('404s unknown asset paths instead of falling through to documents', async () => {
      const handle = captureHandler();
      const res = await handle({ url: 'helm-artifact://asset/other.js' });
      expect(res.status).toBe(404);
    });
  });

  describe('ARTIFACT_CSP', () => {
    it('permits inline script and only the local helm-artifact script source', () => {
      const scriptSrc = /script-src ([^;]*)/.exec(ARTIFACT_CSP)?.[1] ?? '';
      expect(scriptSrc).toContain("'unsafe-inline'");
      expect(scriptSrc).toContain('helm-artifact:');
      expect(scriptSrc).not.toContain("'self'");
      expect(scriptSrc).not.toContain('http');
    });

    it('denies all network egress by default and allows only local image schemes', () => {
      expect(ARTIFACT_CSP).toContain("default-src 'none'");
      expect(ARTIFACT_CSP).toContain('img-src helm-img: data:');
      expect(ARTIFACT_CSP).toContain("form-action 'none'");
      expect(ARTIFACT_CSP).toContain("base-uri 'none'");
    });

    it('allows the file-based Helm renderer to embed the artifact', () => {
      const ancestors = /frame-ancestors ([^;]*)/.exec(ARTIFACT_CSP)?.[1] ?? '';
      expect(ancestors).toContain("'self'");
      expect(ancestors).toContain('file:');
      expect(ancestors).not.toContain('*');
      expect(ancestors).not.toContain('http:');
      expect(ancestors).not.toContain('https:');
    });
  });
});
