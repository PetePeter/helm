/**
 * Temp-file lifecycle for artifacts opened externally.
 *
 * Regression cover for two confirmed bugs:
 *   1. the copy written by artifact:openExternal carried no session id, so it
 *      could never be cleaned up when its session closed, and
 *   2. it was chmod'd 0o444, which makes unlink throw EPERM on Windows — so the
 *      startup sweep silently left every one of them on disk forever.
 *
 * Deliberately runs against a REAL temp directory with REAL files (and real
 * 0o444 permissions) so the EPERM path is genuinely exercised on Windows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

// ─── Test temp dir (real disk) ───────────────────────────────────────────────

let tmpRoot = path.join(os.tmpdir(), `helm-temp-cleanup-${randomUUID()}`);

// ─── Mocks: only the OS/Electron edges, never the units under test ───────────

const handleCalls = new Map<string, Function>();
const mockShellOpenPath = vi.fn(async () => '');

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handleCalls.set(channel, handler); }),
    removeHandler: vi.fn((channel: string) => { handleCalls.delete(channel); }),
  },
  shell: { openPath: (...args: unknown[]) => mockShellOpenPath(...(args as [])) },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  app: { getVersion: () => '0.0.0', isPackaged: false, getAppPath: () => '/app' },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock('../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logDir: os.tmpdir(),
}));

// Only the temp dir is redirected — everything else (config dir, used by session
// persistence) keeps its real behaviour.
vi.mock('../src/utils/app-paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTempDir: () => tmpRoot,
}));

let diskStore: RecycleBinEntry[] = [];
vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  saveRecycleBin: (entries: RecycleBinEntry[]) => { diskStore = [...entries]; },
  loadRecycleBin: () => [...diskStore],
}));

const { artifactTempFileName, ARTIFACT_TEMP_PREFIX } =
  await import('../src/session/artifact-temp-file.js');
const { ArtifactTempRegistry, attachSessionTempCleanup } =
  await import('../src/session/artifact-temp-registry.js');
const { setupArtifactHandlers } = await import('../src/electron/ipc/artifact-handlers.js');
const { setupRecycleBinHandlers } = await import('../src/electron/ipc/recycle-bin-handlers.js');
const { cleanupWorkTempFiles } = await import('../src/electron/ipc/system-handlers.js');
const { ArtifactManager } = await import('../src/session/artifact-manager.js');
const { RecycleBinManager, recordRemovedSession } = await import('../src/session/recycle-bin-manager.js');
const { SessionManager } = await import('../src/session/manager.js');
import type { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';

function getHandler(channel: string): Function {
  const handler = handleCalls.get(channel);
  if (!handler) throw new Error(`No handler for "${channel}"`);
  return handler;
}

/** Write a real file into the temp dir, optionally read-only like production does. */
function writeTemp(name: string, readOnly = false): string {
  const filePath = path.join(tmpRoot, name);
  fs.writeFileSync(filePath, 'body', 'utf8');
  if (readOnly) fs.chmodSync(filePath, 0o444);
  return filePath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockShellOpenPath.mockResolvedValue('');
  handleCalls.clear();
  diskStore = [];
  tmpRoot = path.join(os.tmpdir(), `helm-temp-cleanup-${randomUUID()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  // Force-remove: some fixtures are intentionally read-only.
  for (const file of fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : []) {
    try { fs.chmodSync(path.join(tmpRoot, file), 0o666); } catch { /* ignore */ }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── 1. Filename carries the session id ──────────────────────────────────────

describe('artifact temp filenames', () => {
  it('keeps the sweep prefix and encodes the session id', () => {
    const sessionId = randomUUID();
    const name = artifactTempFileName(sessionId, 'Auth Flow Audit', 'markdown', 1700000000000);

    expect(name.startsWith(ARTIFACT_TEMP_PREFIX)).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).toContain(sessionId);
  });

  it('keeps a hyphen-heavy title from corrupting the session id segment', () => {
    const sessionId = randomUUID();
    const name = artifactTempFileName(sessionId, 'a-b--c - d', 'html', 42);

    expect(name.endsWith('.html')).toBe(true);
    // The id sits before the first `--`, so a title containing `--` cannot
    // shift the boundary.
    expect(name.slice(ARTIFACT_TEMP_PREFIX.length).split('--')[0]).toBe(sessionId);
  });
});

// ─── 2. Registry records what openExternal writes ────────────────────────────

describe('artifact:openExternal temp registry', () => {
  function setup(registry: InstanceType<typeof ArtifactTempRegistry>) {
    const artifactManager = new ArtifactManager(() => {});
    setupArtifactHandlers(
      artifactManager,
      {} as ArtifactAttachmentManager,
      undefined,
      '/app',
      registry,
    );
    return { artifactManager, openExternal: getHandler('artifact:openExternal') };
  }

  it('records the written path under the artifact\'s session id', async () => {
    const registry = new ArtifactTempRegistry();
    const { artifactManager, openExternal } = setup(registry);
    const artifact = artifactManager.create('sess-1', 'Auth Flow Audit', 'markdown', '# body');

    const result = await openExternal({}, artifact.id);

    expect(result.success).toBe(true);
    const written: string = result.path;
    expect(fs.existsSync(written)).toBe(true);
    expect(registry.pathsFor('sess-1')).toEqual([written]);
    expect(registry.pathsFor('sess-2')).toEqual([]);
    expect(path.basename(written)).toContain('sess-1');
  });
});

// ─── 3-4. Session close drains the registry ──────────────────────────────────

describe('session close drains artifact temps', () => {
  it('deletes the closed session\'s temps and leaves another session\'s intact', () => {
    const registry = new ArtifactTempRegistry();
    const mine = writeTemp('helm-artifact-s1--Report-1.md', true);
    const theirs = writeTemp('helm-artifact-s2--Report-2.md', true);
    registry.record('s1', mine);
    registry.record('s2', theirs);

    const sessions = new SessionManager();
    attachSessionTempCleanup(sessions, registry);
    sessions.addSession({ id: 's1', name: 'a', cliType: 'claude-code', processId: 1 });
    sessions.addSession({ id: 's2', name: 'b', cliType: 'claude-code', processId: 2 });

    sessions.removeSession('s1');

    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(registry.pathsFor('s1')).toEqual([]);
    expect(registry.pathsFor('s2')).toEqual([theirs]);
  });

  it('still deletes temps for a recoverable session that lands in the recycle bin', () => {
    const registry = new ArtifactTempRegistry();
    const mine = writeTemp('helm-artifact-s1--Report-1.md', true);
    registry.record('s1', mine);

    const bin = new RecycleBinManager();
    const sessions = new SessionManager();
    attachSessionTempCleanup(sessions, registry);
    sessions.on('session:removed', (event) => {
      recordRemovedSession(event, bin, () => {});
    });
    sessions.addSession({
      id: 's1', name: 'a', cliType: 'claude-code', processId: 1,
      cliSessionName: 'cli-uuid-1', workingDir: 'X:\\work',
    });

    sessions.removeSession('s1');

    expect(bin.count()).toBe(1);          // still recoverable
    expect(fs.existsSync(mine)).toBe(false); // but its temp copy is gone
  });
});

// ─── 5. Permanent-delete paths drain the registry ────────────────────────────

describe('recycle-bin handlers drain artifact temps', () => {
  function binSession(
    bin: InstanceType<typeof RecycleBinManager>,
    sessionId: string,
    closedAt = Date.now(),
  ): RecycleBinEntry {
    return bin.append({
      sessionId,
      name: 'claude',
      cliType: 'claude-code',
      workingDir: 'X:\\work',
      cliSessionName: `uuid-${sessionId}`,
      closedAt,
    });
  }

  it('Forget deletes that session\'s temps only', async () => {
    const registry = new ArtifactTempRegistry();
    const bin = new RecycleBinManager();
    setupRecycleBinHandlers(bin, new ArtifactManager(() => {}), undefined, registry);

    const t1 = writeTemp('helm-artifact-s1--R-1.md', true);
    const t2 = writeTemp('helm-artifact-s2--R-2.md', true);
    registry.record('s1', t1);
    registry.record('s2', t2);
    const e1 = binSession(bin, 's1');
    binSession(bin, 's2');

    await getHandler('recycleBin:forget')(null, e1.id);

    expect(fs.existsSync(t1)).toBe(false);
    expect(fs.existsSync(t2)).toBe(true);
  });

  it('Empty deletes every binned session\'s temps', async () => {
    const registry = new ArtifactTempRegistry();
    const bin = new RecycleBinManager();
    setupRecycleBinHandlers(bin, new ArtifactManager(() => {}), undefined, registry);

    const t1 = writeTemp('helm-artifact-s1--R-1.md', true);
    const t2 = writeTemp('helm-artifact-s2--R-2.md', true);
    registry.record('s1', t1);
    registry.record('s2', t2);
    binSession(bin, 's1');
    binSession(bin, 's2');

    await getHandler('recycleBin:empty')(null);

    expect(fs.existsSync(t1)).toBe(false);
    expect(fs.existsSync(t2)).toBe(false);
  });

  it('an entry expiring at runtime deletes its temps', () => {
    let nowVal = 1_700_000_000_000;
    const registry = new ArtifactTempRegistry();
    const bin = new RecycleBinManager(() => nowVal);
    setupRecycleBinHandlers(bin, new ArtifactManager(() => {}), undefined, registry);

    const t1 = writeTemp('helm-artifact-s1--R-1.md', true);
    registry.record('s1', t1);
    binSession(bin, 's1', nowVal);
    expect(fs.existsSync(t1)).toBe(true);

    nowVal += 7 * 24 * 60 * 60 * 1000 + 1;
    binSession(bin, 's2', nowVal); // append prunes the aged-out entry and fires expired

    expect(fs.existsSync(t1)).toBe(false);
  });
});

// ─── 6. Read-only deletion ───────────────────────────────────────────────────

describe('read-only temp deletion', () => {
  it('deletes a 0o444 file (unlink alone throws EPERM on Windows)', () => {
    const registry = new ArtifactTempRegistry();
    const readOnly = writeTemp('helm-artifact-s1--R-1.md', true);
    registry.record('s1', readOnly);

    const deleted = registry.drain('s1');

    expect(deleted).toEqual([readOnly]);
    expect(fs.existsSync(readOnly)).toBe(false);
  });
});

// ─── 7-8. Startup sweep ──────────────────────────────────────────────────────

describe('cleanupWorkTempFiles', () => {
  it('removes read-only Helm-owned artifact, attachment, and plan temp files', () => {
    const artifactTemp = writeTemp(artifactTempFileName('s1', 'Report', 'markdown', 1), true);
    const planTemp = writeTemp('helm-plan-export-Some_Plan-1.md', true);
    const planAttachmentTemp = writeTemp('helm-attachment-att-1-note.txt', true);
    const mcpArtifactTemp = writeTemp('helm-mcp-artifact-s1--Report-1.md', true);
    const mcpAttachmentTemp = writeTemp('helm-mcp-attachment-att-1-note.txt', true);
    const memoryAttachmentTemp = writeTemp('helm-memory-attachment-temp-1-note.txt', true);
    const workTemp = writeTemp('helm-work-1.md');
    const foreign = writeTemp('not-ours.md');

    cleanupWorkTempFiles('/app');

    expect(fs.existsSync(artifactTemp)).toBe(false);
    expect(fs.existsSync(planTemp)).toBe(false);
    expect(fs.existsSync(planAttachmentTemp)).toBe(false);
    expect(fs.existsSync(mcpArtifactTemp)).toBe(false);
    expect(fs.existsSync(mcpAttachmentTemp)).toBe(false);
    expect(fs.existsSync(memoryAttachmentTemp)).toBe(false);
    expect(fs.existsSync(workTemp)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('still reaps legacy helm-artifact-* names that carry no session id', () => {
    const legacy = writeTemp('helm-artifact-Auth Flow Audit-1700000000000.md', true);

    cleanupWorkTempFiles('/app');

    expect(fs.existsSync(legacy)).toBe(false);
  });
});
