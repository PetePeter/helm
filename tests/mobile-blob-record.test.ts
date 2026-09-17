import { describe, expect, it } from 'vitest';
import {
  BLOB_MARKER,
  decodeBlobResult,
  decodeRecord,
  encodeBlobResult,
  encodeResult,
  isBlobPayload,
} from '../src/mobile/mobile-envelope.js';
import { MAX_FRAME_BYTES } from '../src/mobile/secure-channel.js';
import {
  ARTIFACT_SLICE_MAX_BYTES,
  DOWNLOAD_WRAPPER_HEADROOM_BYTES,
  isArtifactDownloadBinary,
} from '../src/session/artifact-download.js';

/**
 * The binary download reply. It exists because base64 cost a third of the wire
 * and 111 round trips for a 10MB file; every case here is a way that saving
 * could hand the phone a file that LOOKS complete and is not.
 */
describe('the blob record', () => {
  const slice = {
    id: 'c1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    bytes: Buffer.from([0x00, 0x7b, 0xff, 0xfe, 0x10]),
    offset: 0,
    total: 11,
    eof: false,
  };

  it('round-trips a body byte for byte, including bytes UTF-8 would mangle', () => {
    const decoded = decodeBlobResult(encodeBlobResult(slice));
    expect(decoded).not.toBeNull();
    expect(decoded!.bytes.equals(slice.bytes)).toBe(true);
    expect(decoded!.filename).toBe('photo.jpg');
    expect(decoded!.offset).toBe(0);
    expect(decoded!.total).toBe(11);
    expect(decoded!.eof).toBe(false);
  });

  it('round-trips an empty tail slice, which is a real answer and not a failure', () => {
    const decoded = decodeBlobResult(encodeBlobResult({ ...slice, bytes: Buffer.alloc(0), eof: true }));
    expect(decoded!.bytes.length).toBe(0);
    expect(decoded!.eof).toBe(true);
  });

  it('never starts with "{", so a reader can tell it from JSON by one byte', () => {
    // The marker is the whole reason both codecs can dispatch without guessing.
    const payload = encodeBlobResult({ ...slice, bytes: Buffer.from('{"t":"result"}', 'utf8') });
    expect(payload[0]).toBe(BLOB_MARKER);
    expect(payload[0]).not.toBe('{'.charCodeAt(0));
    expect(isBlobPayload(payload)).toBe(true);
    expect(isBlobPayload(encodeResult('c1', { ok: true }))).toBe(false);
  });

  it('is refused by decodeRecord: a phone may only ASK, and it asks in JSON', () => {
    expect(decodeRecord(encodeBlobResult(slice))).toBeNull();
  });

  it('refuses a truncated body rather than reporting a short slice', () => {
    // A slice quietly shorter than promised is exactly the corruption the
    // offset-ordering rules upstream cannot see.
    const payload = encodeBlobResult(slice);
    expect(decodeBlobResult(payload.subarray(0, payload.length - 2))).toBeNull();
  });

  it('refuses a header that is not a blob header, and garbage after the marker', () => {
    expect(decodeBlobResult(Buffer.from([BLOB_MARKER]))).toBeNull();
    expect(decodeBlobResult(Buffer.from([BLOB_MARKER, 0x01, 0x00, 0x03, 0x7b, 0x7d, 0x21]))).toBeNull();
    expect(decodeBlobResult(encodeResult('c1', null))).toBeNull();
  });

  it('carries a full-size slice inside one wire frame, headroom included', () => {
    // The property the constants are FOR: the largest slice the desktop will
    // ever hand back still fits the frame that must carry it.
    const payload = encodeBlobResult({ ...slice, bytes: Buffer.alloc(ARTIFACT_SLICE_MAX_BYTES) });
    expect(payload.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(payload.length + DOWNLOAD_WRAPPER_HEADROOM_BYTES - ARTIFACT_SLICE_MAX_BYTES)
      .toBeLessThanOrEqual(DOWNLOAD_WRAPPER_HEADROOM_BYTES * 2);
  });

  it('recognises a binary download result, and nothing else', () => {
    expect(isArtifactDownloadBinary({ filename: 'a', mimeType: 'b', bytes: Buffer.alloc(1) })).toBe(true);
    // The base64 envelope every local MCP caller still gets must NOT match.
    expect(isArtifactDownloadBinary({ filename: 'a', mimeType: 'b', base64: 'AA==' })).toBe(false);
    expect(isArtifactDownloadBinary(null)).toBe(false);
    expect(isArtifactDownloadBinary('bytes')).toBe(false);
  });
});
