/**
 * artifact:attachmentList / attachmentAdd / attachmentDelete — attachment CRUD
 * on an EXISTING artifact, running the real ArtifactManager and the real
 * ArtifactAttachmentManager against a throwaway temp dir. No mocking of the
 * units under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupArtifactHandlers } from '../src/electron/ipc/artifact-handlers.js';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';

const SESSION = 'sess-1';

let testDir: string;
let artifactManager: ArtifactManager;
let attachmentManager: ArtifactAttachmentManager;
let artifactId: string;

function listAttachments() {
  return handlers.get('artifact:attachmentList')!({}, artifactId);
}

function addAttachment(input: { filename: string; contentBase64: string; contentType?: string }) {
  return handlers.get('artifact:attachmentAdd')!({}, artifactId, input);
}

function deleteAttachment(attachmentId: string) {
  return handlers.get('artifact:attachmentDelete')!({}, artifactId, attachmentId);
}

beforeEach(() => {
  handlers.clear();
  testDir = join(tmpdir(), `helm-test-artifact-attachments-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  artifactManager = new ArtifactManager(() => {});
  attachmentManager = new ArtifactAttachmentManager(testDir);
  setupArtifactHandlers(artifactManager, attachmentManager, undefined, '/app');

  artifactId = artifactManager.create(SESSION, 'Report', 'markdown', '# body', 'manual').id;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('artifact:attachmentAdd', () => {
  it('stores the file and returns its metadata without touching the artifact', () => {
    const att = addAttachment({
      filename: 'evidence.png',
      contentBase64: Buffer.from('fake-png').toString('base64'),
      contentType: 'image/png',
    });

    expect(att.id).toBeTruthy();
    expect(att.artifactId).toBe(artifactId);
    expect(att.filename).toBe('evidence.png');
    expect(att.sizeBytes).toBe(8);

    // Attachments are a side store — the body keeps its own content untouched.
    expect(artifactManager.get(artifactId)!.versions).toHaveLength(1);
    expect(artifactManager.get(artifactId)!.versions[0].content).toBe('# body');
  });

  it('refuses files over 10MB before decoding', () => {
    // The check uses the base64 length (raw ≈ 3/4 of it), so exceed 4/3 of the cap.
    const huge = 'A'.repeat(Math.ceil(10 * 1024 * 1024 * 4 / 3) + 1024);
    expect(() => addAttachment({ filename: 'big.bin', contentBase64: huge })).toThrow('10MB');
  });

  it('refuses an unknown artifact id', () => {
    const handler = handlers.get('artifact:attachmentAdd')!;
    expect(() => handler({}, 'no-such-artifact', {
      filename: 'x.png',
      contentBase64: Buffer.from('x').toString('base64'),
    })).toThrow('Artifact not found');
  });
});

describe('artifact:attachmentList / attachmentDelete', () => {
  it('reflects add and delete', () => {
    expect(listAttachments()).toEqual([]);

    const a = addAttachment({
      filename: 'one.pdf',
      contentBase64: Buffer.from('%PDF-1.4').toString('base64'),
      contentType: 'application/pdf',
    });
    const b = addAttachment({
      filename: 'two.png',
      contentBase64: Buffer.from('png-bytes').toString('base64'),
      contentType: 'image/png',
    });
    expect(listAttachments().map((att: { id: string }) => att.id)).toEqual([a.id, b.id]);

    expect(deleteAttachment(a.id)).toBe(true);
    expect(listAttachments().map((att: { id: string }) => att.id)).toEqual([b.id]);

    // Deleting again is false, not a throw — an already-gone row is fine.
    expect(deleteAttachment(a.id)).toBe(false);
  });
});
