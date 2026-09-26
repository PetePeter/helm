/**
 * Share-to-Helm — a file shared from the phone lands in the Helm inbox and a
 * draft on the picked session names it.
 *
 * Real MobileGate → real dispatcher → real upload service → real inbox and
 * DraftManager on a throwaway dir. The only stand-in is the service facade's
 * session lookup, because standing up a SessionManager proves nothing here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MobileGate, MOBILE_DENY_MESSAGE, RESERVED_MOBILE_TOOLS_METHOD } from '../src/mobile/mobile-gate.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { PeerRateLimiter } from '../src/mcp/peer/rate-limiter.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { MobileArtifactUploadService, UPLOAD_MAX_SLICE_BYTES } from '../src/mobile/mobile-artifact-upload.js';
import { MobileShareInbox, safeShareFilename } from '../src/mobile/mobile-share-inbox.js';
import { MAX_ATTACHMENT_BYTES } from '../src/session/artifact-attachment-manager.js';
import { DraftManager } from '../src/session/draft-manager.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const SESSION = '11111111-2222-4333-8444-555555555555';
const FILE = Buffer.from('%PDF-1.7 pretend this is a scanned receipt');
const SHA = createHash('sha256').update(FILE).digest('hex');

let inboxDir: string;

beforeEach(() => {
  inboxDir = mkdtempSync(join(tmpdir(), 'helm-share-inbox-'));
});
afterEach(() => {
  rmSync(inboxDir, { recursive: true, force: true });
});

function build(allow: string[] = ['*']) {
  const drafts = new DraftManager();
  const uploads = new MobileArtifactUploadService({
    attachments: { add: () => { throw new Error('a share must never become an attachment'); } },
    shares: new MobileShareInbox(inboxDir, drafts),
  });
  const service = {
    getSession: (id: string) => (id === SESSION ? { id } : null),
    openShareUpload: (target: string, deviceId: string, input: Record<string, unknown>) =>
      uploads.openShare(deviceId, { ...(input as { filename: string; sizeBytes: number; sha256: string }), sessionId: target }),
    commitShareUpload: (deviceId: string, uploadId: string) => uploads.commitShare(deviceId, uploadId),
    commitArtifactAttachmentUpload: (_caller: string, deviceId: string, uploadId: string) =>
      uploads.commit(deviceId, uploadId),
  };
  const store = new MobileDeviceStore(undefined, () => 0);
  const device = store.add({ machineId: 'phone', name: 'Pixel', pskRef: 'psk', allow });
  const gate = new MobileGate({
    deviceStore: store,
    dispatch: (method, params, ctx) =>
      callMcpTool(
        { service: service as never, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() },
        method,
        params as Record<string, unknown>,
        ctx,
      ),
    rateLimiter: new PeerRateLimiter({ capacity: 100, refillPerMs: 1, now: () => 0 }),
  });
  return { gate, uploads, drafts, deviceId: device.id };
}

type Offer = { uploadId: string; maxSliceBytes: number; total: number };

function open(built: ReturnType<typeof build>, overrides: Record<string, unknown> = {}) {
  return built.gate.handle(built.deviceId, 'session_share_file_add', {
    sessionId: SESSION,
    filename: 'receipt.pdf',
    contentType: 'application/pdf',
    sizeBytes: FILE.byteLength,
    sha256: SHA,
    ...overrides,
  }) as Promise<Offer>;
}

function sendWhole(built: ReturnType<typeof build>, uploadId: string, bytes = FILE) {
  return built.uploads.acceptSlice(built.deviceId, {
    id: uploadId, filename: 'receipt.pdf', mimeType: 'application/pdf', bytes, offset: 0, eof: true,
  });
}

describe('share-to-Helm through the mobile gate', () => {
  it('lands the file in the inbox and adds a draft naming its path, without sending it', async () => {
    const built = build();
    const offer = await open(built);
    expect(offer.maxSliceBytes).toBe(UPLOAD_MAX_SLICE_BYTES);
    expect(sendWhole(built, offer.uploadId)).toMatchObject({ ok: true, complete: true });

    const receipt = await built.gate.handle(built.deviceId, 'session_share_file_commit', {
      uploadId: offer.uploadId,
    }) as { sessionId: string; path: string; draftId: string };

    expect(receipt.sessionId).toBe(SESSION);
    expect(receipt.path.startsWith(inboxDir)).toBe(true);
    expect(readFileSync(receipt.path)).toEqual(FILE);
    const [draft] = built.drafts.getForSession(SESSION);
    expect(draft.id).toBe(receipt.draftId);
    expect(draft.text).toBe(`Attached: receipt.pdf at ${receipt.path}`);
  });

  it('is on the permitted surface a wildcard phone discovers', async () => {
    const built = build();
    const { tools } = await built.gate.handle(built.deviceId, RESERVED_MOBILE_TOOLS_METHOD, {}) as { tools: Array<{ name: string }> };
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['session_share_file_add', 'session_share_file_commit']));
  });

  it('is denied to a device whose allow-list does not grant it', async () => {
    const built = build(['session_list']);
    await expect(open(built)).rejects.toThrow(MOBILE_DENY_MESSAGE);
  });

  it('refuses an unknown session before a slot exists', async () => {
    const built = build();
    await expect(open(built, { sessionId: 'nope' })).rejects.toThrow(/Session not found/);
  });

  it('refuses a file past the 10 MB cap at open', async () => {
    const built = build();
    await expect(open(built, { sizeBytes: MAX_ATTACHMENT_BYTES + 1 })).rejects.toThrow(/upload cap/);
  });

  it('leaves no file and no draft when the bytes miss their checksum', async () => {
    const built = build();
    const offer = await open(built);
    sendWhole(built, offer.uploadId, Buffer.from('X'.repeat(FILE.byteLength)));
    await expect(
      built.gate.handle(built.deviceId, 'session_share_file_commit', { uploadId: offer.uploadId }),
    ).rejects.toThrow(/checksum/);
    expect(readdirSync(inboxDir)).toEqual([]);
    expect(built.drafts.getForSession(SESSION)).toEqual([]);
  });

  it('never lets an artifact commit finish a share slot', async () => {
    const built = build();
    const offer = await open(built);
    sendWhole(built, offer.uploadId);
    await expect(
      built.gate.handle(built.deviceId, 'session_artifact_attachment_commit', { uploadId: offer.uploadId }),
    ).rejects.toThrow(/Upload not found/);
  });

  it('keeps a hostile filename inside the inbox', async () => {
    const built = build();
    const offer = await open(built, { filename: '..\\..\\evil<1>.txt' });
    sendWhole(built, offer.uploadId);
    const receipt = await built.gate.handle(built.deviceId, 'session_share_file_commit', {
      uploadId: offer.uploadId,
    }) as { path: string };
    expect(dirname(dirname(receipt.path))).toBe(inboxDir);
    expect(existsSync(receipt.path)).toBe(true);
  });
});

describe('safeShareFilename', () => {
  it('strips directories and reserved characters, and never answers empty', () => {
    expect(safeShareFilename('../../a/b:c?.png')).toBe('b_c_.png');
    expect(safeShareFilename('...')).toBe('shared-file');
  });
});
