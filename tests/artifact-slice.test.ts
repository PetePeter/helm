import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';
import {
  ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES,
  resolveSliceWindow,
} from '../src/session/artifact-download.js';

/**
 * Slicing exists so a phone can fetch a file bigger than one wire frame. Every
 * case here is a way a caller looping to `eof` could end up with a file that is
 * silently WRONG — short, padded, or truncated — which is worse than a failure
 * it can see.
 */
describe('resolveSliceWindow', () => {
  it('takes a full window from the front of a larger file', () => {
    expect(resolveSliceWindow(200_000, 0, 64 * 1024)).toEqual({
      offset: 0,
      length: 64 * 1024,
      eof: false,
    });
  });

  it('shortens the last window to the tail and calls it the end', () => {
    const window = resolveSliceWindow(100, 80, 64 * 1024);
    expect(window).toEqual({ offset: 80, length: 20, eof: true });
  });

  it('answers an offset past the end with nothing, rather than an error', () => {
    // A loop that lands exactly on the boundary asks once more. Throwing there
    // would make correct code look like a failure.
    expect(resolveSliceWindow(100, 500)).toEqual({ offset: 500, length: 0, eof: true });
  });

  it('defaults to as much as a frame can carry when no length is asked for', () => {
    const window = resolveSliceWindow(10 * 1024 * 1024);
    expect(window.offset).toBe(0);
    expect(window.length).toBe(ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES);
    expect(window.eof).toBe(false);
  });

  it('refuses a length past the frame budget instead of quietly shortening it', () => {
    // Truncating would be indistinguishable from a short tail, and a caller
    // advancing by what it ASKED for would skip bytes and save a corrupt file.
    expect(() => resolveSliceWindow(10_000_000, 0, ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES + 1))
      .toThrow(/slice budget/);
  });

  it('refuses nonsense offsets and lengths where they are asked', () => {
    expect(() => resolveSliceWindow(100, -1)).toThrow(/non-negative/);
    expect(() => resolveSliceWindow(100, 1.5)).toThrow(/non-negative/);
    expect(() => resolveSliceWindow(100, 0, 0)).toThrow(/positive/);
    expect(() => resolveSliceWindow(100, 0, Number.NaN)).toThrow(/positive/);
  });

  it('calls a window that exactly consumes the file the end', () => {
    expect(resolveSliceWindow(100, 50, 50).eof).toBe(true);
    expect(resolveSliceWindow(100, 50, 49).eof).toBe(false);
  });
});

describe('ArtifactAttachmentManager.readSlice', () => {
  let configDir: string;
  let manager: ArtifactAttachmentManager;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'helm-slice-'));
    manager = new ArtifactAttachmentManager(configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  /** A file well past the single-frame cap — the case that used to be refused. */
  function addLargeAttachment(bytes: number) {
    const content = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) content[i] = i % 251;
    return { attachment: manager.add('a1', { filename: 'photo.jpg', content }), content };
  }

  it('reassembles a file larger than one frame from consecutive slices', () => {
    const size = ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES * 2 + 1234;
    const { attachment, content } = addLargeAttachment(size);

    const parts: Buffer[] = [];
    let offset = 0;
    let eof = false;
    let calls = 0;
    while (!eof) {
      const slice = manager.readSlice('a1', attachment.id, offset, 64 * 1024);
      parts.push(slice.bytes);
      offset += slice.bytes.byteLength;
      eof = slice.window.eof;
      expect(slice.total).toBe(size);
      if (++calls > 100) throw new Error('slice loop never reached eof');
    }

    expect(Buffer.concat(parts).equals(content)).toBe(true);
  });

  it('reads only the window asked for, not the whole file', () => {
    const { attachment, content } = addLargeAttachment(300_000);
    const slice = manager.readSlice('a1', attachment.id, 1000, 500);

    expect(slice.bytes.byteLength).toBe(500);
    expect(slice.bytes.equals(content.subarray(1000, 1500))).toBe(true);
    expect(slice.window.eof).toBe(false);
  });

  it('returns an empty final slice rather than failing at the boundary', () => {
    const { attachment } = addLargeAttachment(100);
    const slice = manager.readSlice('a1', attachment.id, 100, 64);

    expect(slice.bytes.byteLength).toBe(0);
    expect(slice.window.eof).toBe(true);
  });

  it('serves a small attachment whole when no window is asked for', () => {
    // The pre-slicing behaviour, which callers that never page must keep.
    const content = Buffer.from('a short note');
    const attachment = manager.add('a1', { filename: 'note.txt', content });

    const slice = manager.readSlice('a1', attachment.id);
    expect(slice.bytes.equals(content)).toBe(true);
    expect(slice.window.eof).toBe(true);
    expect(slice.total).toBe(content.byteLength);
  });

  it('reports the truth when the file shrinks under a reader', () => {
    const { attachment } = addLargeAttachment(200_000);
    const path = manager.getPath('a1', attachment.id);
    const window = { offset: 0, length: 64 * 1024 };

    writeFileSync(path, Buffer.alloc(100));
    const slice = manager.readSlice('a1', attachment.id, window.offset, window.length);

    // Padding the tail with zeroes would be saved as real bytes by the phone.
    expect(slice.bytes.byteLength).toBe(100);
    expect(slice.window.eof).toBe(true);
  });

  it('refuses an unknown attachment rather than answering emptiness', () => {
    expect(() => manager.readSlice('a1', 'nope')).toThrow(/Attachment not found/);
  });
});
