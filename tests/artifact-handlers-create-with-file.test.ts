/**
 * artifact:createWithFile — a drag-drop / paste / file-pick attach must produce
 * ONE artifact version holding the real markdown, and fire exactly one
 * changed + one reveal event.
 *
 * Regression: the handler used to seed an empty version 1 and then update() it,
 * so every attach created two versions and doubled both events.
 *
 * These run the real ArtifactManager and the real ArtifactAttachmentManager
 * against a throwaway temp dir — no mocking of the units under test.
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
let persisted: Record<string, unknown[]>;
let changedEvents: string[];
let revealEvents: Array<[string, string]>;

function createWithFile(input: { filename: string; contentBase64: string; contentType?: string; intent?: 'normal' | 'manifesto' }) {
  return handlers.get('artifact:createWithFile')!({}, SESSION, input) as {
    artifact: { id: string; versions: Array<{ version: number; content: string }> };
    attachment: { id: string };
  };
}

beforeEach(() => {
  handlers.clear();
  testDir = join(tmpdir(), `helm-test-createwithfile-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  persisted = {};
  changedEvents = [];
  revealEvents = [];

  artifactManager = new ArtifactManager(all => { persisted = all; });
  artifactManager.on('artifact:changed', (sessionId: string) => changedEvents.push(sessionId));
  artifactManager.on('artifact:reveal', (sessionId: string, artifactId: string) => {
    revealEvents.push([sessionId, artifactId]);
  });

  attachmentManager = new ArtifactAttachmentManager(testDir);
  setupArtifactHandlers(artifactManager, attachmentManager, undefined, '/app');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('artifact:createWithFile', () => {
  it('creates imported files with their selected intent', () => {
    const { artifact } = createWithFile({
      filename: 'rules.md',
      contentBase64: Buffer.from('# rules').toString('base64'),
      intent: 'manifesto',
    });

    expect(artifactManager.get(artifact.id)?.intent).toBe('manifesto');
    expect(artifactManager.getManifestosForSession(SESSION)).toHaveLength(1);
  });

  it('produces exactly one version holding the real markdown', () => {
    const { artifact } = createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    });

    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0].version).toBe(1);
    expect(artifact.versions[0].content).not.toBe('');
    expect(artifact.versions[0].content).toContain('![screenshot.png](');

    // The stored artifact — not just the returned copy — must hold the content.
    const stored = artifactManager.get(artifact.id)!;
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0].content).toBe(artifact.versions[0].content);
  });

  it('writes a non-image attachment as a metadata card in version 1', () => {
    const { artifact } = createWithFile({
      filename: 'notes.pdf',
      contentBase64: Buffer.from('%PDF-1.4 body').toString('base64'),
      contentType: 'application/pdf',
    });

    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0].content).toContain('**notes.pdf**');
    expect(artifact.versions[0].content).toContain('application/pdf');
  });

  it('emits exactly one changed event and one reveal event', () => {
    const { artifact } = createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    });

    expect(changedEvents).toEqual([SESSION]);
    expect(revealEvents).toEqual([[SESSION, artifact.id]]);
  });

  it('persists the artifact once, with real content in version 1', () => {
    createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    });

    const stored = persisted[SESSION] as Array<{ versions: Array<{ content: string }> }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].versions).toHaveLength(1);
    expect(stored[0].versions[0].content).not.toBe('');
  });

  it('leaves no stranded artifact when attachment storage fails', () => {
    vi.spyOn(attachmentManager, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    })).toThrow('disk full');

    expect(artifactManager.getForSession(SESSION)).toHaveLength(0);
    expect(changedEvents).toEqual([]);
    expect(revealEvents).toEqual([]);
  });

  it('leaves no stranded artifact when resolving the stored path fails', () => {
    vi.spyOn(attachmentManager, 'getPath').mockImplementation(() => {
      throw new Error('Attachment file missing');
    });

    expect(() => createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    })).toThrow('Attachment file missing');

    expect(artifactManager.getForSession(SESSION)).toHaveLength(0);
    expect(changedEvents).toEqual([]);
    expect(revealEvents).toEqual([]);
  });

  it('still appends version 2 on a subsequent update', () => {
    const { artifact } = createWithFile({
      filename: 'screenshot.png',
      contentBase64: Buffer.from('fake-png-bytes').toString('base64'),
      contentType: 'image/png',
    });

    const updated = artifactManager.update(artifact.id, '# edited')!;

    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[1].version).toBe(2);
    expect(updated.versions[1].content).toBe('# edited');
  });
});

describe('artifact:createText', () => {
  it('produces exactly one version with the given content', () => {
    const artifact = handlers.get('artifact:createText')!({}, SESSION, 'Notes', '# hello') as {
      versions: Array<{ version: number; content: string }>;
    };

    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0].content).toBe('# hello');
    expect(changedEvents).toEqual([SESSION]);
    expect(revealEvents).toHaveLength(1);
  });

  it('changes intent through the metadata-only handler without adding a version', () => {
    const artifact = handlers.get('artifact:createText')!({}, SESSION, 'Notes', '# hello') as {
      id: string;
      versions: Array<{ version: number; content: string }>;
    };

    expect(handlers.get('artifact:setIntent')!({}, artifact.id, 'manifesto')).toBe(true);

    const stored = artifactManager.get(artifact.id)!;
    expect(stored.intent).toBe('manifesto');
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0].content).toBe('# hello');
  });
});
