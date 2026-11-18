import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectStore } from '../src/session/project-store.js';
import { normalizeProjectPath } from '../src/session/project-identity.js';

// Case-folding of paths only happens on win32 (see normalizeProjectPath) — tests
// asserting case-insensitive behavior are gated to Windows, with case-preserving
// counterparts below them. Storage-logic assertions compare against
// normalizeProjectPath(input) so they hold on every platform.
const isWin = process.platform === 'win32';
const norm = normalizeProjectPath;

describe('ProjectStore', () => {
  let tmpDir: string;
  let projectsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-project-store-'));
    projectsFile = path.join(tmpDir, 'projects.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns same object reference on cache hit', () => {
    const store = new ProjectStore(projectsFile);
    const first = store.resolveForPath('X:\\coding\\repo');
    const second = store.resolveForPath('X:\\coding\\repo');
    expect(first).toBe(second);
  });

  it('creates distinct projects for distinct paths', () => {
    const store = new ProjectStore(projectsFile);
    const a = store.resolveForPath('X:\\coding\\alpha');
    const b = store.resolveForPath('X:\\coding\\beta');
    expect(a.id).not.toBe(b.id);
    expect(store.list()).toHaveLength(2);
  });

  it.runIf(isWin)('normalizes path on lookup so case-variant paths resolve to the same project on Windows', () => {
    const store = new ProjectStore(projectsFile);
    const lower = store.resolveForPath('x:\\coding\\repo');
    const upper = store.resolveForPath('X:\\Coding\\Repo');
    expect(lower).toBe(upper);
    expect(store.list()).toHaveLength(1);
  });

  it.runIf(!isWin)('keeps case-variant paths as distinct projects on Unix', () => {
    const store = new ProjectStore(projectsFile);
    const lower = store.resolveForPath('/coding/repo');
    const upper = store.resolveForPath('/Coding/Repo');
    expect(lower).not.toBe(upper);
    expect(store.list()).toHaveLength(2);
  });

  it('sets canonicalPath to the normalized input path', () => {
    const store = new ProjectStore(projectsFile);
    const record = store.resolveForPath('X:\\coding\\Repo\\');
    expect(record.canonicalPath).toBe(norm('X:\\coding\\Repo\\'));
  });

  it('sets name to the trailing folder segment', () => {
    const store = new ProjectStore(projectsFile);
    const record = store.resolveForPath('X:\\coding\\my-project');
    expect(record.name).toBe('my-project');
  });

  describe('resolveForPath with alternate paths', () => {
    it('returns the existing project when the path is a registered alternate (no phantom project)', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\folder-b');
      const resolved = store.resolveForPath('X:\\coding\\folder-b');
      expect(resolved.id).toBe(record.id);
    });

    it('does not create a duplicate project for an alternate path', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\folder-b');
      store.resolveForPath('X:\\coding\\folder-b');
      expect(store.list()).toHaveLength(1);
    });

    it('resolves a trailing-slash-variant alternate path to the same project', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\folder-b');
      const resolved = store.resolveForPath('X:\\coding\\folder-b\\');
      expect(resolved.id).toBe(record.id);
      expect(store.list()).toHaveLength(1);
    });

    it.runIf(isWin)('resolves a case-variant alternate path to the same project on Windows', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\folder-b');
      const resolved = store.resolveForPath('X:\\Coding\\Folder-B\\');
      expect(resolved.id).toBe(record.id);
      expect(store.list()).toHaveLength(1);
    });

    it('still creates a new standalone project for a genuinely unregistered path', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\folder-b');
      const other = store.resolveForPath('X:\\coding\\unrelated');
      expect(other.id).not.toBe(record.id);
      expect(store.list()).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns record by id', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      expect(store.getById(record.id)).toBe(record);
    });

    it('returns undefined for unknown id', () => {
      const store = new ProjectStore(projectsFile);
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('findByPath', () => {
    it('finds a record by canonical path without creating new projects', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      expect(store.findByPath('X:\\coding\\repo')?.id).toBe(record.id);
      expect(store.findByPath('X:\\coding\\other')).toBeUndefined();
    });

    it('finds a record by alternate path', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(store.findByPath('X:\\coding\\worktree-b')?.id).toBe(record.id);
    });

    it.runIf(isWin)('is case-insensitive for alternate paths on Windows', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\Worktree-B');
      expect(store.findByPath('x:\\coding\\worktree-b')?.id).toBe(record.id);
    });

    it.runIf(!isWin)('is case-sensitive for alternate paths on Unix', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('/coding/repo');
      store.addDirectory(record.id, '/coding/Worktree-B');
      expect(store.findByPath('/coding/Worktree-B')?.id).toBe(record.id);
      expect(store.findByPath('/coding/worktree-b')).toBeUndefined();
    });
  });

  describe('addDirectory', () => {
    it('adds a path to alternatePaths', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(record.alternatePaths).toContain(norm('X:\\coding\\worktree-b'));
    });

    it('normalizes the path before adding (trailing slash stripped)', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b\\');
      expect(record.alternatePaths).toContain(norm('X:\\coding\\worktree-b'));
    });

    it.runIf(isWin)('normalizes case before adding on Windows', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\Coding\\Worktree-B\\');
      expect(record.alternatePaths).toContain('x:\\coding\\worktree-b');
    });

    it('is idempotent — no duplicate entries', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(record.alternatePaths?.filter(p => p === norm('X:\\coding\\worktree-b'))).toHaveLength(1);
    });

    it('throws for unknown project id', () => {
      const store = new ProjectStore(projectsFile);
      expect(() => store.addDirectory('nonexistent', 'X:\\coding\\extra')).toThrow();
    });

    it('marks store dirty', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.save();
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(store.isDirty()).toBe(true);
    });
  });

  describe('removeDirectory', () => {
    it('removes a path from alternatePaths', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.removeDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(record.alternatePaths).not.toContain(norm('X:\\coding\\worktree-b'));
    });

    it('is silent when path not present', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      expect(() => store.removeDirectory(record.id, 'X:\\coding\\missing')).not.toThrow();
    });

    it('throws for unknown project id', () => {
      const store = new ProjectStore(projectsFile);
      expect(() => store.removeDirectory('nonexistent', 'X:\\coding\\extra')).toThrow();
    });

    it('marks store dirty', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.save();
      store.removeDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(store.isDirty()).toBe(true);
    });
  });

  describe('setMainDirectory', () => {
    it('swaps an alternate path into canonicalPath', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.setMainDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(record.canonicalPath).toBe(norm('X:\\coding\\worktree-b'));
    });

    it('old canonical becomes an alternate after swap', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.setMainDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(record.alternatePaths).toContain(norm('X:\\coding\\repo'));
    });

    it('throws if path is not an alternate', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      expect(() => store.setMainDirectory(record.id, 'X:\\coding\\not-an-alt')).toThrow();
    });

    it('marks store dirty', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.save();
      store.setMainDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(store.isDirty()).toBe(true);
    });
  });

  describe('rename', () => {
    it('updates name and updatedAt', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      const before = record.updatedAt;
      store.rename(record.id, 'My Project');
      expect(record.name).toBe('My Project');
      expect(record.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('marks store dirty', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.save();
      store.rename(record.id, 'Renamed');
      expect(store.isDirty()).toBe(true);
    });

    it('throws for unknown id', () => {
      const store = new ProjectStore(projectsFile);
      expect(() => store.rename('nonexistent', 'X')).toThrow();
    });

    it('notifies listeners for project mutations that affect scheduler labels', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      const changes: string[] = [];
      store.onChanged((projects) => changes.push(projects[0]?.name ?? 'missing'));

      store.rename(record.id, 'Renamed');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.removeDirectory(record.id, 'X:\\coding\\worktree-b');

      expect(changes).toEqual(['Renamed', 'Renamed', 'Renamed']);
    });
  });

  describe('delete', () => {
    it('removes the project record', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.delete(record.id);
      expect(store.list()).toHaveLength(0);
      expect(store.getById(record.id)).toBeUndefined();
    });

    it('clears cache so re-resolving the path creates a new project', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.delete(record.id);
      const newRecord = store.resolveForPath('X:\\coding\\repo');
      expect(newRecord.id).not.toBe(record.id);
    });
  });

  describe('createProject', () => {
    it('creates a new standalone project record', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.createProject('X:\\coding\\fresh');
      expect(record.id).toBeTruthy();
      expect(store.list()).toHaveLength(1);
      expect(store.getById(record.id)).toBe(record);
    });

    it('sets canonicalPath to the normalized input path', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.createProject('X:\\coding\\Fresh\\');
      expect(record.canonicalPath).toBe(norm('X:\\coding\\Fresh\\'));
    });

    it('defaults name to the trailing folder segment', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.createProject('X:\\coding\\my-fresh-project');
      expect(record.name).toBe('my-fresh-project');
    });

    it('uses an explicit name when provided', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.createProject('X:\\coding\\fresh', 'Fresh Label');
      expect(record.name).toBe('Fresh Label');
    });

    it('throws when the canonical path is already registered', () => {
      const store = new ProjectStore(projectsFile);
      store.createProject('X:\\coding\\fresh');
      expect(() => store.createProject('X:\\coding\\fresh')).toThrow(/already registered/i);
    });

    it.runIf(isWin)('throws for a case-variant of a registered path on Windows', () => {
      const store = new ProjectStore(projectsFile);
      store.createProject('X:\\coding\\fresh');
      expect(() => store.createProject('x:\\coding\\Fresh')).toThrow(/already registered/i);
    });

    it('throws when the path is already an alternate path of another project', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      expect(() => store.createProject('X:\\coding\\worktree-b')).toThrow(/already registered/i);
    });

    it('marks store dirty', () => {
      const store = new ProjectStore(projectsFile);
      store.save();
      store.createProject('X:\\coding\\fresh');
      expect(store.isDirty()).toBe(true);
    });
  });

  describe('save / isDirty', () => {
    it('is dirty after resolveForPath creates a new record', () => {
      const store = new ProjectStore(projectsFile);
      store.resolveForPath('X:\\coding\\repo');
      expect(store.isDirty()).toBe(true);
    });

    it('is not dirty after save', () => {
      const store = new ProjectStore(projectsFile);
      store.resolveForPath('X:\\coding\\repo');
      store.save();
      expect(store.isDirty()).toBe(false);
    });

    it('persists records to disk and reloads them', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.save();

      const store2 = new ProjectStore(projectsFile);
      expect(store2.getById(record.id)?.canonicalPath).toBe(record.canonicalPath);
    });

    it('persists alternatePaths through save and reload', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.addDirectory(record.id, 'X:\\coding\\worktree-b');
      store.save();

      const store2 = new ProjectStore(projectsFile);
      expect(store2.getById(record.id)?.alternatePaths).toContain(norm('X:\\coding\\worktree-b'));
    });

    it('persists picker visibility without removing the project', () => {
      const store = new ProjectStore(projectsFile);
      const record = store.resolveForPath('X:\\coding\\repo');
      store.setHiddenFromPicker(record.id, true);
      store.save();

      const reloaded = new ProjectStore(projectsFile);
      expect(reloaded.list()).toHaveLength(1);
      expect(reloaded.getById(record.id)?.hiddenFromPicker).toBe(true);

      reloaded.setHiddenFromPicker(record.id, false);
      reloaded.save();
      expect(new ProjectStore(projectsFile).getById(record.id)?.hiddenFromPicker).toBeUndefined();
    });
  });
});
