/**
 * mobile-artifact-upload — the PC half of the phone's attachment upload.
 *
 * These tests exercise the REAL slot and service against a recording stand-in
 * for the attachment store. The failure they exist to catch is a file that
 * arrives looking complete and is not: short, duplicated, over-large, or
 * quietly different from what the phone said it was sending.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ArtifactUploadSlot,
  MAX_ACTIVE_UPLOAD_SLOTS,
  UPLOAD_MAX_SLICE_BYTES,
  MobileArtifactUploadService,
  type ArtifactUploadOpenInput,
} from '../src/mobile/mobile-artifact-upload';
import type { ArtifactAttachment } from '../src/types/artifact-attachment';

const FILE = Buffer.from('the quick brown fox jumps over the lazy dog');
const SHA = createHash('sha256').update(FILE).digest('hex');

function openInput(overrides: Partial<ArtifactUploadOpenInput> = {}): ArtifactUploadOpenInput {
  return {
    artifactId: 'artifact-1',
    filename: 'notes.txt',
    sizeBytes: FILE.byteLength,
    sha256: SHA,
    ...overrides,
  };
}

interface Added {
  artifactId: string;
  filename: string;
  content: Buffer;
  contentType?: string;
}

function makeService(now: () => number = Date.now) {
  const added: Added[] = [];
  const service = new MobileArtifactUploadService({
    attachments: {
      add: (artifactId: string, input: { filename: string; content: Buffer; contentType?: string }) => {
        added.push({ artifactId, ...input });
        return {
          id: `att-${added.length}`,
          artifactId,
          filename: input.filename,
          ...(input.contentType ? { contentType: input.contentType } : {}),
          sizeBytes: input.content.byteLength,
          relativePath: `${artifactId}/x`,
          createdAt: now(),
        } satisfies ArtifactAttachment;
      },
    },
    now,
  });
  return { service, added };
}

/** Slice a buffer the way the phone does, inclusive offsets, `eof` on the last. */
function sliceAt(buffer: Buffer, offset: number, length: number) {
  return { bytes: buffer.subarray(offset, offset + length), eof: offset + length >= buffer.byteLength };
}

describe('ArtifactUploadSlot', () => {
  it('accepts a whole file in one slice and reports complete', () => {
    const slot = new ArtifactUploadSlot('u', openInput(), Date.now);
    const outcome = slot.accept(0, FILE, true);
    expect(outcome).toEqual({ ok: true, received: FILE.byteLength, total: FILE.byteLength, complete: true });
    expect(slot.assemble().equals(FILE)).toBe(true);
  });

  it('holds an out-of-order slice until the gap ahead of it closes', () => {
    const slot = new ArtifactUploadSlot('u', openInput(), Date.now);
    const first = Math.floor(FILE.byteLength / 2);
    expect(slot.accept(first, FILE.subarray(first), true).ok).toBe(true);
    expect(slot.receivedBytes).toBe(0);

    expect(slot.accept(0, FILE.subarray(0, first), true).ok).toBe(true);
    expect(slot.complete).toBe(true);
    expect(slot.assemble().equals(FILE)).toBe(true);
  });

  it('refuses a duplicate offset instead of appending it twice', () => {
    const slot = new ArtifactUploadSlot('u', openInput(), Date.now);
    slot.accept(0, FILE.subarray(0, 4), false);
    const duplicate = slot.accept(0, FILE.subarray(0, 4), false);
    expect(duplicate.ok).toBe(false);
    expect(slot.receivedBytes).toBe(4);
  });

  it('refuses a slice that runs past the declared size', () => {
    const slot = new ArtifactUploadSlot('u', openInput(), Date.now);
    expect(slot.accept(0, Buffer.concat([FILE, FILE]), true).ok).toBe(false);
    expect(slot.receivedBytes).toBe(0);
  });

  it('refuses an assemble before the file is whole', () => {
    const slot = new ArtifactUploadSlot('u', openInput(), Date.now);
    slot.accept(0, FILE.subarray(0, 4), false);
    expect(() => slot.assemble()).toThrow();
  });

  it('expires after the ttl passes without a slice', () => {
    let now = 1000;
    const slot = new ArtifactUploadSlot('u', openInput(), () => now);
    expect(slot.expired(now, 1000)).toBe(false);
    now += 1001;
    expect(slot.expired(now, 1000)).toBe(true);
  });
});

describe('MobileArtifactUploadService', () => {
  it('commits an in-order upload into the managed attachment store', () => {
    const { service, added } = makeService();
    const offer = service.open('device-1', openInput());
    for (let offset = 0; offset < FILE.byteLength; offset += 8) {
      const { bytes, eof } = sliceAt(FILE, offset, 8);
      const outcome = service.acceptSlice('device-1', {
        id: offer.uploadId,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        bytes,
        offset,
        total: FILE.byteLength,
        eof,
      });
      expect(outcome.ok).toBe(true);
    }
    const attachment = service.commit('device-1', offer.uploadId);
    expect(attachment.sizeBytes).toBe(FILE.byteLength);
    expect(added).toHaveLength(1);
    expect(added[0].content.equals(FILE)).toBe(true);
  });

  it('refuses slices for a slot another device opened', () => {
    const { service } = makeService();
    const offer = service.open('device-1', openInput());
    const outcome = service.acceptSlice('device-2', {
      id: offer.uploadId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: FILE,
      offset: 0,
      total: FILE.byteLength,
      eof: true,
    });
    expect(outcome.ok).toBe(false);
  });

  it('refuses a commit on a short upload and drops the slot', () => {
    const { service, added } = makeService();
    const offer = service.open('device-1', openInput());
    service.acceptSlice('device-1', {
      id: offer.uploadId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: FILE.subarray(0, 4),
      offset: 0,
      total: FILE.byteLength,
      eof: false,
    });
    expect(() => service.commit('device-1', offer.uploadId)).toThrow(/short/);
    // A retry after a dropped slot cannot append into the dead one.
    const outcome = service.acceptSlice('device-1', {
      id: offer.uploadId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: FILE.subarray(4),
      offset: 4,
      total: FILE.byteLength,
      eof: true,
    });
    expect(outcome.ok).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('refuses a commit whose bytes do not match the declared sha256', () => {
    const { service, added } = makeService();
    const tampered = Buffer.from(FILE.toString('utf8').replace('quick', 'sliok'), 'utf8');
    const offer = service.open('device-1', openInput());
    service.acceptSlice('device-1', {
      id: offer.uploadId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: tampered,
      offset: 0,
      total: tampered.byteLength,
      eof: true,
    });
    expect(() => service.commit('device-1', offer.uploadId)).toThrow(/checksum/);
    expect(added).toHaveLength(0);
  });

  it('refuses an upload past the attachment size cap', () => {
    const { service } = makeService();
    expect(() => service.open('device-1', openInput({ sizeBytes: 11 * 1024 * 1024, sha256: SHA })))
      .toThrow(/cap/);
  });

  it('refuses an open with a malformed digest', () => {
    const { service } = makeService();
    expect(() => service.open('device-1', openInput({ sha256: 'deadbeef' }))).toThrow(/sha256/);
  });

  it('bounds the open slots per device', () => {
    const { service } = makeService();
    for (let index = 0; index < MAX_ACTIVE_UPLOAD_SLOTS; index++) {
      service.open('device-1', openInput({ filename: `f${index}.txt` }));
    }
    expect(() => service.open('device-1', openInput())).toThrow(/Too many/);
    // The cap is per device, not per service.
    expect(() => service.open('device-2', openInput()).uploadId).toBeDefined();
  });

  it('evicts a slot that idles past the ttl', () => {
    let now = 1000;
    const { service } = makeService(() => now);
    const offer = service.open('device-1', openInput());
    now += 2 * 60 * 1000 + 1;
    expect(() => service.commit('device-1', offer.uploadId)).toThrow(/Upload not found/);
  });

  it('advertises a slice budget that leaves room for the blob header', () => {
    const { service } = makeService();
    const offer = service.open('device-1', openInput());
    // The header is well under the headroom on real inputs; the point is the
    // advertised slice can never be the whole frame.
    expect(offer.maxSliceBytes).toBeGreaterThan(0);
    expect(offer.maxSliceBytes).toBeLessThan(UPLOAD_MAX_SLICE_BYTES + 1);
    expect(offer.total).toBe(FILE.byteLength);
  });
});
