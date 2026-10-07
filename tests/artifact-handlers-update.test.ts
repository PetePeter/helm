/**
 * artifact:update — the renderer's in-situ editor saves a new VERSION rather
 * than rewriting history, and refuses blank content.
 *
 * Runs the real ArtifactManager through the real handler; only Electron's
 * ipcMain is stubbed to capture the registered handlers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler); }),
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
import type { Artifact } from '../src/types/artifact.js';

const SESSION = 'sess-1';

let artifactManager: ArtifactManager;

function update(artifactId: string, content: string): Artifact | null {
  return handlers.get('artifact:update')!({}, artifactId, content) as Artifact | null;
}

beforeEach(() => {
  handlers.clear();
  artifactManager = new ArtifactManager(() => { /* persistence not under test */ });
  setupArtifactHandlers(artifactManager, new ArtifactAttachmentManager('/tmp/helm-test-update'), undefined, '/app');
});

describe('artifact:update', () => {
  it('appends a new version and keeps the earlier one intact', () => {
    const created = artifactManager.create(SESSION, 'Notes', 'markdown', 'first', 'manual');

    const updated = update(created.id, 'second');

    expect(updated?.versions.map(v => v.content)).toEqual(['first', 'second']);
    expect(updated?.versions.map(v => v.version)).toEqual([1, 2]);
  });

  it('returns null for an unknown artifact id without throwing', () => {
    expect(update('does-not-exist', 'body')).toBeNull();
  });

  it('refuses blank content instead of storing an empty version', () => {
    const created = artifactManager.create(SESSION, 'Notes', 'markdown', 'first', 'manual');

    expect(update(created.id, '   ')).toBeNull();
    expect(artifactManager.get(created.id)!.versions).toHaveLength(1);
  });

  // Save is the user committing what they were drafting: one version, and the
  // draft it came from is spent.
  it('commits the draft: one new version, and no draft left behind', () => {
    const created = artifactManager.create(SESSION, 'Notes', 'markdown', 'first', 'manual');
    handlers.get('artifact:setDraft')!({}, created.id, 'work in progress');

    const updated = update(created.id, 'finished');

    expect(updated?.versions.map(v => v.content)).toEqual(['first', 'finished']);
    expect(artifactManager.get(created.id)!.draft).toBeUndefined();
  });
});

describe('artifact drafts', () => {
  const setDraft = (id: string, content: string) => handlers.get('artifact:setDraft')!({}, id, content) as boolean;
  const discardDraft = (id: string) => handlers.get('artifact:discardDraft')!({}, id) as boolean;

  it('keeps autosaved text on the artifact without adding a version', () => {
    const created = artifactManager.create(SESSION, 'Notes', 'markdown', 'first', 'manual');

    expect(setDraft(created.id, 'typing…')).toBe(true);
    expect(setDraft(created.id, 'typing more…')).toBe(true);

    const stored = artifactManager.get(created.id)!;
    expect(stored.draft?.content).toBe('typing more…');
    expect(stored.versions.map(v => v.content)).toEqual(['first']);
  });

  it('discards the draft and leaves the versions untouched', () => {
    const created = artifactManager.create(SESSION, 'Notes', 'markdown', 'first', 'manual');
    setDraft(created.id, 'thrown away');

    expect(discardDraft(created.id)).toBe(true);

    const stored = artifactManager.get(created.id)!;
    expect(stored.draft).toBeUndefined();
    expect(stored.versions.map(v => v.content)).toEqual(['first']);
  });

  it('reports an unknown artifact instead of throwing', () => {
    expect(setDraft('does-not-exist', 'x')).toBe(false);
    expect(discardDraft('does-not-exist')).toBe(false);
  });
});
