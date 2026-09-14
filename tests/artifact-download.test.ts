/**
 * buildArtifactDownload / buildArtifactRead — the bounded envelopes a phone
 * receives for one artifact, as a file or inline.
 *
 * A real ArtifactManager produces the artifacts; what is under test is the
 * envelope: the filename a phone can save under, the ONE version an inline read
 * carries, and the wire budget that keeps a big report from being pushed into a
 * 128KiB SecureChannel frame a chunk at a time. The budget is checked on the
 * ENCODED bytes — a decoded-only cap once let a boundary-size body encode past
 * the frame ceiling and tear the link instead of refusing. The inline read
 * needed the same lesson a second time: its body is a plain JSON string, so
 * JSON ESCAPING inflates it after the decoded count — a frame-full of quotes
 * escaped to ~1.5 frames past an unchanged decoded cap.
 */

import { describe, expect, it } from 'vitest';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import {
  ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES,
  ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES,
  ARTIFACT_INLINE_MAX_ESCAPED_BYTES,
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

/**
 * A control character from the worst JSON escape class — 1 byte becomes a
 * 6-byte \u00XX escape on the wire (unlike \n, whose escape costs 2). Built via
 * fromCharCode so no escape-sequence literal has to survive this file.
 */
const ESCAPE6 = String.fromCharCode(1);

describe('the wire budget itself', () => {
  it('fits inside the mobile frame ceiling with the wrapper headroom intact', () => {
    // These constants live in a different layer than MAX_FRAME_BYTES on
    // purpose; this is the pin that keeps them honest. Headroom must stay
    // strictly positive, or the wrapper itself bursts the frame.
    expect(ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES).toBe(MAX_FRAME_BYTES - DOWNLOAD_WRAPPER_HEADROOM_BYTES);
    expect(ARTIFACT_INLINE_MAX_ESCAPED_BYTES).toBe(MAX_FRAME_BYTES - DOWNLOAD_WRAPPER_HEADROOM_BYTES);
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

  it('refuses content whose JSON-escaped form cannot ride a frame', () => {
    // Control characters are the worst escape class: one UTF-8 byte becomes a
    // 6-byte \u00XX escape. Decoded, this body is under the download cap;
    // escaped, it is half again past the frame.
    const over = ESCAPE6.repeat(Math.floor((ARTIFACT_INLINE_MAX_ESCAPED_BYTES - 2) / 6) + 1);
    expect(Buffer.byteLength(over, 'utf8')).toBeLessThan(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', over);
    expect(() => buildArtifactRead(artifact)).toThrow('fetch it on the desktop instead');
  });

  it('refuses quote-heavy content a decoded-only cap would have let tear the link', () => {
    // THE REGRESSION: every quote doubles on its way into the JSON record, so
    // this body — exactly the size the OLD decoded cap accepted — escapes to
    // ~189KiB, and the sealed frame burst in writeFrame instead of refusing
    // here.
    const quotes = '"'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', quotes);
    expect(Buffer.byteLength(JSON.stringify(quotes), 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(() => buildArtifactRead(artifact)).toThrow('past the');
  });

  it('serves control-char content whose escaped form lands inside the cap', () => {
    // The -2 is the value's own two JSON quote characters, which the cap also
    // has to carry; below, this is the largest 6-byte-class body that fits.
    const atCap = ESCAPE6.repeat(Math.floor((ARTIFACT_INLINE_MAX_ESCAPED_BYTES - 2) / 6));
    expect(Buffer.byteLength(JSON.stringify(atCap), 'utf8')).toBeLessThanOrEqual(ARTIFACT_INLINE_MAX_ESCAPED_BYTES);
    const { artifact } = managerWith('markdown', atCap);
    expect(buildArtifactRead(artifact).requestedVersionContent).toBe(atCap);
  });

  it('refuses one control character past the escaped cap', () => {
    const over = ESCAPE6.repeat(Math.floor((ARTIFACT_INLINE_MAX_ESCAPED_BYTES - 2) / 6) + 1);
    const { artifact } = managerWith('markdown', over);
    expect(() => buildArtifactRead(artifact)).toThrow('escaping to');
  });

  it('lets JSON-inert content use the full frame budget escaping would waste', () => {
    // Plain ASCII ships 1:1 plus its two quotes — the upside of MEASURING the
    // escaped form instead of deriving the cap from the base64 ratio.
    const atCap = 'x'.repeat(ARTIFACT_INLINE_MAX_ESCAPED_BYTES - 2);
    const { artifact } = managerWith('markdown', atCap);
    expect(buildArtifactRead(artifact).requestedVersionContent).toBe(atCap);

    const { artifact: over } = managerWith('markdown', atCap + 'x');
    expect(() => buildArtifactRead(over)).toThrow('past the');
  });

  it('still measures DECODED bytes, so multibyte content cannot dodge the cap', () => {
    // 'é' is 2 UTF-8 bytes but 1 character; a character count would let half a
    // frame through as "small". Escaping leaves it untouched, so the decoded
    // pre-check is what condemns it.
    const multibyte = 'é'.repeat(ARTIFACT_INLINE_MAX_ESCAPED_BYTES);
    const { artifact } = managerWith('markdown', multibyte);
    expect(() => buildArtifactRead(artifact)).toThrow('past the');
  });

  it('never lets an accepted read escape past the frame with the wrapper aboard', () => {
    // The end-to-end property the bug broke: the worst escape class at the
    // largest size the budget accepts, wrapped in the result record the mobile
    // link actually sends, plus the sealed frame's type byte, 8-byte sequence
    // and 16-byte tag, must still fit MAX_FRAME_BYTES.
    const atCap = ESCAPE6.repeat(Math.floor((ARTIFACT_INLINE_MAX_ESCAPED_BYTES - 2) / 6));
    const { artifact } = managerWith('markdown', atCap);
    const read = buildArtifactRead(artifact);

    const record = JSON.stringify({ v: 1, t: 'result', id: 'x'.repeat(64), result: read });
    const sealedFrameOverheadBytes = 1 + 8 + 16;
    expect(Buffer.byteLength(record, 'utf8') + sealedFrameOverheadBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it('still downloads the quote-heavy body the inline read refuses', () => {
    // base64 output is JSON-inert, so the DOWNLOAD cap is untouched: this same
    // body encodes to exactly the download budget. One artifact, two envelopes,
    // two honest answers.
    const quotes = '"'.repeat(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    const { artifact } = managerWith('markdown', quotes);

    expect(() => buildArtifactRead(artifact)).toThrow();
    expect(buildArtifactDownload(artifact).base64).toHaveLength(ARTIFACT_DOWNLOAD_MAX_ENCODED_BYTES);
  });

  it('lets an empty version body through — nothing to encode, nothing to burst', () => {
    const { artifact } = managerWith('markdown', '');
    const read = buildArtifactRead(artifact);
    expect(read.requestedVersionContent).toBe('');
  });
});
