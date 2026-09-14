/**
 * buildArtifactDownload / buildArtifactRead — the bounded envelopes a phone
 * receives for one artifact, as a file or inline.
 *
 * A real ArtifactManager produces the artifacts; what is under test is the
 * envelope: the filename a phone can save under, the ONE version an inline read
 * carries, and the wire budget that keeps a big report from being pushed into a
 * 128KiB SecureChannel frame a chunk at a time. The budget is checked on the
 * ENCODED bytes — a decoded-only cap once let a boundary-size body encode past
 * the frame ceiling and tear the link instead of refusing.
 */

import { describe, expect, it } from 'vitest';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import {
  ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES,
  ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES,
  DOWNLOAD_WRAPPER_HEADROOM_BYTES,
  buildArtifactDownload,
  buildArtifactRead,
} from '../src/session/artifact-download.js';
import { MAX_FRAME_BYTES } from '../src/mobile/secure-channel.js';

function managerWith(kind: 'markdown' | 'html', content: string, title = 'Q3 report') {
  const manager = new ArtifactManager(undefined, () => 1700000000000);
  const artifact = manager.create('s1', title, kind, content);
  return { manager, artifact };
}

describe('the wire budget itself', () => {
  it('fits inside the mobile frame ceiling with the wrapper headroom intact', () => {
    // These two live in different layers on purpose; this is the pin that keeps
    // them honest. Headroom must stay strictly positive, or the wrapper itself
    // bursts the frame.
    expect(ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES).toBe(MAX_FRAME_BYTES - DOWNLOAD_WRAPPER_HEADROOM_BYTES);
    expect(DOWNLOAD_WRAPPER_HEADROOM_BYTES).toBeGreaterThan(0);
  });

  it('lets a body at the cap encode inside the budget', () => {
    const exact = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const encoded = Buffer.from(exact, 'utf8').toString('base64');
    expect(encoded.length).toBe(ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES);
  });
});

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

  it('refuses content past the cap and points at the desktop', () => {
    const big = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES + 1);
    const { artifact } = managerWith('markdown', big);
    expect(() => buildArtifactDownload(artifact)).toThrow('fetch it on the desktop instead');
  });

  it('still serves content at exactly the cap', () => {
    const exact = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', exact);
    expect(buildArtifactDownload(artifact).size).toBe(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
  });

  it('caps the DECODED bytes, so multibyte content is measured honestly', () => {
    // 'é' is 2 bytes in UTF-8 but 1 character; a character count would let this through.
    const multibyte = 'é'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', multibyte);
    expect(() => buildArtifactDownload(artifact)).toThrow('past the');
  });

  it('never lets an accepted download encode past the wire budget', () => {
    // The property the old decoded-only cap broke: everything that passes the
    // pre-check must still fit the frame ceiling once base64d.
    const atCap = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', atCap);
    const { base64 } = buildArtifactDownload(artifact);
    expect(base64.length + DOWNLOAD_WRAPPER_HEADROOM_BYTES).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe('buildArtifactRead', () => {
  it('carries metadata plus exactly ONE version, never the whole history', () => {
    const manager = new ArtifactManager(undefined, () => 1700000000000);
    const created = manager.create('s1', 'report', 'markdown', 'v1', undefined, 'a-fixed-id');
    manager.update(created.id, 'v2');
    manager.update(created.id, 'v3');

    const read = buildArtifactRead(manager.get(created.id)!);

    expect(read).toEqual({
      id: 'a-fixed-id',
      title: 'report',
      kind: 'markdown',
      versionCount: 3,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      requestedVersion: 3,
      requestedVersionContent: 'v3',
    });
  });

  it('serves the requested earlier version inline', () => {
    const manager = new ArtifactManager(undefined, () => 1700000000000);
    const created = manager.create('s1', 'report', 'markdown', 'v1');
    manager.update(created.id, 'v2');

    const read = buildArtifactRead(manager.get(created.id)!, 1);
    expect(read.requestedVersion).toBe(1);
    expect(read.requestedVersionContent).toBe('v1');
  });

  it('applies the same wire budget as a download', () => {
    const big = 'x'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES + 1);
    const { artifact } = managerWith('markdown', big);
    expect(() => buildArtifactRead(artifact)).toThrow('fetch it on the desktop instead');
  });

  it('lets an empty version body through — nothing to encode, nothing to burst', () => {
    const { artifact } = managerWith('markdown', '');
    const read = buildArtifactRead(artifact);
    expect(read.requestedVersionContent).toBe('');
  });
});
