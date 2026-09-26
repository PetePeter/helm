/**
 * mobile-artifact-upload — the PC half of a phone pushing file bytes UP.
 *
 * Protocol 4 turned the binary `blob` record around: what protocol 3 used only
 * for download replies now also carries UPLOAD slices phone → Helm. The record
 * frame is byte-identical in both directions; what changed is who is talking,
 * which is why it is a protocol bump and not a field.
 *
 * There is no per-slice ack, deliberately. The download path answers each
 * `session_artifact_download` call with one blob, but an upload's slices are NOT
 * calls — they are payloads filling a slot the gate already created. The
 * handshake is therefore three moves, only the byte stream of which skips the
 * gate:
 *
 *   1. `session_artifact_attachment_add`    → opens a slot, answers
 *      `{ uploadId, maxSliceBytes }`.
 *   2. blob records, `id` = uploadId        → raw slices, streamed silently.
 *   3. `session_artifact_attachment_commit` → verifies size + sha256, commits
 *      the attachment into the artifact's managed storage, answers with it.
 *
 * Share-to-Helm rides the same slots: `session_share_file_add` opens a slot
 * whose commit (`session_share_file_commit`) hands the verified bytes to a
 * `ShareSink` — the inbox + draft — instead of the attachment store. The slot's
 * kind is fixed at open; a commit of the other kind answers not-found.
 *
 * That keeps the boundary sentence true by construction rather than by
 * discipline: every inbound record is still a `call` through MobileGate, or a
 * payload for a slot only a gated call could have opened, bound to the device
 * that opened it. Another paired phone — or an unpaired one — cannot push
 * slices into somebody else's slot, because the slot checks the device on every
 * slice and on the commit.
 *
 * Failure is the same story as the phone's own download assembler
 * (data/ChatAttachmentPull.kt): a file that LOOKS complete and is not is the
 * one failure this exists to prevent. A slice past the declared size is
 * refused, never stored; a duplicate offset is refused; the declared size is
 * the ceiling; and the sha256 declared at open time is verified before anything
 * is committed. A slot that is never finished simply expires.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { MobileBlobResult } from './mobile-envelope.js';
import { ARTIFACT_SLICE_MAX_BYTES } from '../session/artifact-download.js';
import { MAX_ATTACHMENT_BYTES } from '../session/artifact-attachment-manager.js';
import type { ArtifactAttachmentManager } from '../session/artifact-attachment-manager.js';
import type { ArtifactAttachment } from '../types/artifact-attachment.js';
import { logger } from '../utils/logger.js';

/**
 * A slot lives this long without a slice before it is evicted. A BLE photo
 * takes minutes, not hours; a link silent past two minutes has lost its
 * transfer anyway, and the phone's retry opens a fresh slot.
 */
export const UPLOAD_SLOT_TTL_MS = 2 * 60 * 1000;

/** Open slots per device. One upload at a time is the app's own flow; three is slack. */
export const MAX_ACTIVE_UPLOAD_SLOTS = 3;

/**
 * Room in the frame for the blob record AROUND its raw slice: the marker, the
 * header JSON (filename, mime, ids) and the AEAD wrapper. Generous on purpose —
 * under-reserving here fails as a refused slice, which is what the phone would
 * see anyway, but legibly rather than as a torn link.
 */
export const UPLOAD_SLICE_HEADROOM_BYTES = 2 * 1024;

/** The biggest raw slice a phone may put in one blob record. */
export const UPLOAD_MAX_SLICE_BYTES = ARTIFACT_SLICE_MAX_BYTES - UPLOAD_SLICE_HEADROOM_BYTES;

/** A sha256 digest rides as exactly this many lowercase hex characters. */
const SHA256_HEX_LENGTH = 64;

/** What every upload declares up front, whatever it lands as. */
export interface UploadOpenInput {
  filename: string;
  contentType?: string;
  /** The whole file's size, declared up front. It is the slot's hard ceiling. */
  sizeBytes: number;
  /** sha256 hex of the WHOLE file — verified once, at commit, not per slice. */
  sha256: string;
}

export interface ArtifactUploadOpenInput extends UploadOpenInput {
  artifactId: string;
}

/** A file shared from the phone's share sheet into a session's draft. */
export interface ShareUploadOpenInput extends UploadOpenInput {
  sessionId: string;
}

/** Where a committed share landed: the inbox path and the draft naming it. */
export interface ShareReceipt {
  sessionId: string;
  path: string;
  draftId: string;
}

/** The sink a committed share is handed to — `MobileShareInbox` in production. */
export interface ShareSink {
  receive(sessionId: string, filename: string, content: Buffer): ShareReceipt;
}

export interface ArtifactUploadOffer {
  uploadId: string;
  /** The biggest raw slice this link will accept in one blob record. */
  maxSliceBytes: number;
  total: number;
}

export type SliceOutcome =
  | { ok: true; received: number; total: number; complete: boolean }
  | { ok: false; reason: string };

/**
 * One file crossing the link, one slice at a time, PC side. The mirror of the
 * phone's `AttachmentTransfer`, which faces the same corruption from the other
 * direction:
 *  - A slice that would run past the declared size is REFUSED, not truncated.
 *    Truncating would commit a plausible file that is not the file declared.
 *  - A duplicate offset is refused — a slice the link delivered twice would
 *    otherwise be appended twice.
 *  - An out-of-order slice is HELD, not refused: both transports are ordered,
 *    but holding costs nothing and refusing one would fail an upload the wire
 *    actually carried.
 */
export class ArtifactUploadSlot {
  /** Contiguous bytes in hand, in arrival order. */
  private readonly parts: Buffer[] = [];

  /** Bytes held ahead of the gap, keyed by where they start. */
  private readonly early = new Map<number, Buffer>();

  private received = 0;
  private endSeen = false;
  private lastActivity: number;

  constructor(
    readonly uploadId: string,
    readonly input: UploadOpenInput,
    private readonly now: () => number,
  ) {
    this.lastActivity = now();
  }

  /** Contiguous bytes in hand — what an honest progress bar shows. */
  get receivedBytes(): number {
    return this.received;
  }

  get totalBytes(): number {
    return this.input.sizeBytes;
  }

  /** Everything declared has arrived and a final slice said so. */
  get complete(): boolean {
    return this.endSeen && this.received >= this.input.sizeBytes;
  }

  accept(offset: number, bytes: Buffer, eof: boolean): SliceOutcome {
    this.touch();
    if (this.complete) return { ok: false, reason: 'the upload is already complete' };
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, reason: 'offset must be a non-negative integer' };
    }
    if (bytes.length > UPLOAD_MAX_SLICE_BYTES) {
      return { ok: false, reason: `the slice is past the ${UPLOAD_MAX_SLICE_BYTES}-byte budget` };
    }
    if (offset + bytes.length > this.input.sizeBytes) {
      return { ok: false, reason: 'the slice runs past the declared file size' };
    }
    if (offset < this.received || this.early.has(offset)) {
      return { ok: false, reason: 'duplicate slice offset' };
    }

    if (offset === this.received) {
      // The gap closes here; whatever was held beyond it folds in.
      this.parts.push(bytes);
      this.received += bytes.length;
      this.drain();
    } else {
      this.early.set(offset, bytes);
      return { ok: true, received: this.received, total: this.input.sizeBytes, complete: false };
    }

    if (eof) this.endSeen = true;
    return {
      ok: true,
      received: this.received,
      total: this.input.sizeBytes,
      complete: this.complete,
    };
  }

  /** Fold in whatever already arrived beyond the gap just closed. */
  private drain(): void {
    while (true) {
      const next = this.early.get(this.received);
      if (next === undefined) return;
      this.early.delete(this.received);
      this.parts.push(next);
      this.received += next.length;
    }
  }

  /**
   * The whole file. Only once [complete]; asking early would hand back a
   * truncated buffer that nothing downstream could tell from a finished one.
   */
  assemble(): Buffer {
    if (!this.complete) throw new Error('the upload has not received every byte');
    return Buffer.concat(this.parts);
  }

  touch(): void {
    this.lastActivity = this.now();
  }

  expired(at: number, ttlMs: number): boolean {
    return at - this.lastActivity > ttlMs;
  }
}

/** What a slot becomes once committed. The kind is fixed at open time. */
type UploadTarget =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'share'; sessionId: string };

interface SlotEntry {
  owner: string;
  target: UploadTarget;
  slot: ArtifactUploadSlot;
}

export interface ArtifactUploadDeps {
  /** Where a finished upload is committed. Only `add` is needed. */
  attachments: Pick<ArtifactAttachmentManager, 'add'>;
  /** Where a committed share lands. ABSENT means shares are refused at open. */
  shares?: ShareSink;
  now?: () => number;
  ttlMs?: number;
}

/**
 * The registry of open slots, and the three moves a phone makes against them.
 * Every throwing path is a caller-facing error: it arrives as the gate's
 * JSON-RPC failure for the call that made it. Slice refusals are not — they are
 * answers to nobody, so they come back as `{ ok: false, reason }` and the
 * bridge logs them.
 */
export class MobileArtifactUploadService {
  private readonly entries = new Map<string, SlotEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: ArtifactUploadDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? UPLOAD_SLOT_TTL_MS;
  }

  /** Move 1: open a slot for an artifact attachment. */
  open(deviceId: string, input: ArtifactUploadOpenInput): ArtifactUploadOffer {
    const { artifactId, ...common } = input;
    return this.openSlot(deviceId, common, { kind: 'artifact', artifactId });
  }

  /** Move 1, share flavour: the file will land in a session's draft. */
  openShare(deviceId: string, input: ShareUploadOpenInput): ArtifactUploadOffer {
    if (!this.deps.shares) throw new Error('File sharing is not available on this hub');
    const { sessionId, ...common } = input;
    return this.openSlot(deviceId, common, { kind: 'share', sessionId });
  }

  private openSlot(deviceId: string, input: UploadOpenInput, target: UploadTarget): ArtifactUploadOffer {
    this.sweep();
    const size = input.sizeBytes;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error('sizeBytes must be a positive integer');
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is ${size} bytes, past the ${MAX_ATTACHMENT_BYTES}-byte upload cap`);
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new Error('sha256 must be a 64-character lowercase hex digest of the whole file');
    }
    if (this.slotsFor(deviceId).length >= MAX_ACTIVE_UPLOAD_SLOTS) {
      throw new Error('Too many uploads are already in flight');
    }

    const uploadId = randomUUID();
    this.entries.set(uploadId, {
      owner: deviceId,
      target,
      slot: new ArtifactUploadSlot(uploadId, input, this.now),
    });
    logger.info(`[mobile-artifact-upload] opened ${target.kind} slot for device ${deviceId} bytes=${size}`);
    return { uploadId, maxSliceBytes: UPLOAD_MAX_SLICE_BYTES, total: size };
  }

  /** Move 2: one raw slice. Answers nothing on the wire — the commit does that. */
  acceptSlice(deviceId: string, blob: MobileBlobResult): SliceOutcome {
    const entry = this.entries.get(blob.id);
    // A slot belonging to ANOTHER device is indistinguishable from a missing
    // one: the refusal names nothing about whose upload that id is.
    if (!entry || entry.owner !== deviceId) {
      return { ok: false, reason: 'no upload slot under that id' };
    }
    if (blob.offset === undefined) {
      return { ok: false, reason: 'an upload slice must carry an offset' };
    }
    return entry.slot.accept(blob.offset, blob.bytes, blob.eof ?? false);
  }

  /** Move 3: verify and commit. Returns the attachment the CLI can now read. */
  commit(deviceId: string, uploadId: string): ArtifactAttachment {
    const { target, input, whole } = this.verified(deviceId, uploadId, 'artifact');
    const attachment = this.deps.attachments.add(target.artifactId, {
      filename: input.filename,
      content: whole,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
    logger.info(`[mobile-artifact-upload] committed attachment ${attachment.id} to artifact ${target.artifactId}`);
    return attachment;
  }

  /** Move 3, share flavour: the file lands in the inbox and a draft names it. */
  commitShare(deviceId: string, uploadId: string): ShareReceipt {
    const { target, input, whole } = this.verified(deviceId, uploadId, 'share');
    const receipt = this.deps.shares!.receive(target.sessionId, input.filename, whole);
    logger.info(`[mobile-artifact-upload] shared file landed for session ${target.sessionId}`);
    return receipt;
  }

  /**
   * The whole file, checked. A slot of the OTHER kind answers not-found, same
   * as another device's — an artifact commit can never finish a share, and
   * vice versa. The slot is dropped whatever happens after the lookup.
   */
  private verified<K extends UploadTarget['kind']>(
    deviceId: string,
    uploadId: string,
    kind: K,
  ): { target: Extract<UploadTarget, { kind: K }>; input: UploadOpenInput; whole: Buffer } {
    this.sweep();
    const entry = this.entries.get(uploadId);
    if (!entry || entry.owner !== deviceId || entry.target.kind !== kind) {
      throw new Error(`Upload not found: ${uploadId}`);
    }
    this.drop(deviceId, uploadId);
    if (!entry.slot.complete) {
      throw new Error(
        `Upload is short: ${entry.slot.receivedBytes} of ${entry.slot.totalBytes} bytes arrived`,
      );
    }
    const whole = entry.slot.assemble();
    // A file that fails its checksum is not kept; a retry starts from a clean slot.
    if (createHash('sha256').update(whole).digest('hex') !== entry.slot.input.sha256) {
      throw new Error('The uploaded file did not match its declared checksum');
    }
    return {
      target: entry.target as Extract<UploadTarget, { kind: K }>,
      input: entry.slot.input,
      whole,
    };
  }

  /** Abandon a slot. Idempotent — an unknown id, or another device's, is a no-op. */
  drop(deviceId: string, uploadId: string): void {
    const entry = this.entries.get(uploadId);
    if (!entry || entry.owner !== deviceId) return;
    this.entries.delete(uploadId);
  }

  /** Evict every slot idle past the TTL. Runs before anything reads the map. */
  sweep(): void {
    const at = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.slot.expired(at, this.ttlMs)) {
        this.entries.delete(id);
        logger.info('[mobile-artifact-upload] an upload slot expired unfinished');
      }
    }
  }

  private slotsFor(deviceId: string): ArtifactUploadSlot[] {
    return [...this.entries.values()].filter(entry => entry.owner === deviceId).map(e => e.slot);
  }
}
