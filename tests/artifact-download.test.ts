/**
 * buildArtifactDownload — the phone's file-download envelope for one artifact.
 *
 * A real ArtifactManager produces the artifacts; the only thing under test is
 * the envelope: the filename a phone can save under, the mime it should serve,
 * and the size cap that keeps a 4 MiB report from being pushed through a BLE
 * framing cap a chunk at a time.
 */

import { describe, expect, it } from 'vitest';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import {
  ARTIFACT_DOWNLOAD_MAX_BYTES,
  buildArtifactDownload,
} from '../src/session/artifact-download.js';

function managerWith(kind: 'markdown' | 'html', content: string, title = 'Q3 report') {
  const manager = new ArtifactManager(undefined, () => 1700000000000);
  const artifact = manager.create('s1', title, kind, content);
  return { manager, artifact };
}

describe('buildArtifactDownload', () => {
  it('wraps the latest version in a base64 envelope', () => {
    const { artifact } = managerWith('markdown', '# hello');
    const download = buildArtifactDownload(artifact);

    expect(download.mimeType).toBe('text/markdown');
    expect(download.base64).toBe(Buffer.from('# hello', 'utf8').toString('base64'));
    expect(Buffer.from(download.base64, 'base64').toString('utf8')).toBe('# hello');
  });

  it('derives a filesystem-safe filename from the title and the kind extension', () => {
    const { artifact } = managerWith('markdown', 'body', 'Notes: v2  "final" ?');
    expect(buildArtifactDownload(artifact).filename).toBe('Notes-v2-final.md');
  });

  it('uses the html extension and mime for an html artifact', () => {
    const { artifact } = managerWith('html', '<p>hi</p>');
    const download = buildArtifactDownload(artifact);
    expect(download.filename).toBe('Q3-report.html');
    expect(download.mimeType).toBe('text/html');
  });

  it('falls back to a usable filename when the title has no safe characters', () => {
    const { artifact } = managerWith('markdown', 'body', '///');
    expect(buildArtifactDownload(artifact).filename).toMatch(/^artifact.*\.md$/);
  });

  it('serves a specific earlier version on request', () => {
    const manager = new ArtifactManager(undefined, () => 1700000000000);
    const artifact = manager.create('s1', 'report', 'markdown', 'v1');
    manager.update(artifact.id, 'v2');

    const download = buildArtifactDownload(manager.get(artifact.id)!, 1);
    expect(Buffer.from(download.base64, 'base64').toString('utf8')).toBe('v1');
  });

  it('rejects a version the artifact does not have', () => {
    const { artifact } = managerWith('markdown', 'only v1');
    expect(() => buildArtifactDownload(artifact, 9)).toThrow('has no version 9');
  });

  it('refuses content past the download cap and points at the desktop', () => {
    const big = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_BYTES + 1);
    const { artifact } = managerWith('markdown', big);
    expect(() => buildArtifactDownload(artifact)).toThrow('fetch it on the desktop');
  });

  it('still serves content at exactly the cap', () => {
    const exact = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_BYTES);
    const { artifact } = managerWith('markdown', exact);
    expect(buildArtifactDownload(artifact).size).toBe(ARTIFACT_DOWNLOAD_MAX_BYTES);
  });

  it('caps the DECODED bytes, so multibyte content is measured honestly', () => {
    // 'é' is 2 bytes in UTF-8 but 1 character; a character count would let this through.
    const multibyte = 'é'.repeat(ARTIFACT_DOWNLOAD_MAX_BYTES);
    const { artifact } = managerWith('markdown', multibyte);
    expect(() => buildArtifactDownload(artifact)).toThrow('fetch it on the desktop');
  });
});
