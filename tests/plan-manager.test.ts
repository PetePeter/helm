/**
 * PlanManager unit tests — Phase 1 data layer for Directory Plans.
 * TDD: tests written first, implementation follows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// PlanManager constructor does file I/O — mock all persistence functions
vi.mock('../src/session/persistence.js', () => ({
  savePlanFile: vi.fn(),
  deletePlanFile: vi.fn(),
  listPlanFiles: vi.fn(() => []),
  loadPlanFile: vi.fn(() => null),
  loadDependencies: vi.fn(() => []),
  saveDependencies: vi.fn(),
  cleanupOrphanDependencies: vi.fn(() => ({ removed: 0, deps: [] })),
  loadPlanSequences: vi.fn(() => []),
  savePlanSequences: vi.fn(),
  loadPlanContexts: vi.fn(() => []),
  savePlanContexts: vi.fn(),
  loadPlanContextBindings: vi.fn(() => []),
  savePlanContextBindings: vi.fn(),
  loadProjectRecords: vi.fn(() => []),
  saveProjectRecords: vi.fn(),
}));

import { PlanManager } from '../src/session/plan-manager.js';
import { ProjectStore } from '../src/session/project-store.js';
import * as persistence from '../src/session/persistence.js';

describe('PlanManager', () => {
  let pm: PlanManager;

  beforeEach(() => {
    (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (persistence.savePlanFile as unknown as ReturnType<typeof vi.fn>).mockClear();
    (persistence.loadPlanSequences as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (persistence.savePlanSequences as unknown as ReturnType<typeof vi.fn>).mockClear();
    pm = new PlanManager();
  });

  // ─── CRUD ───────────────────────────────────────────────

  describe('create', () => {
    it('creates item with all fields populated', () => {
      const item = pm.create('/projects/backend', 'Build Auth', 'JWT middleware');

      expect(item.id).toBeDefined();
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.dirPath).toBe('/projects/backend');
      expect(item.title).toBe('Build Auth');
      expect(item.description).toBe('JWT middleware');
      expect(item.humanId).toMatch(/^P-\d{4,}$/);
      expect(item.createdAt).toBeTypeOf('number');
      expect(item.stateUpdatedAt).toBeTypeOf('number');
      expect(item.updatedAt).toBeTypeOf('number');
    });

    it('sets no-dep item to ready immediately', () => {
      const item = pm.create('/projects/backend', 'Standalone', 'No deps');
      expect(item.status).toBe('ready');
    });

    it('assigns unique IDs', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');

      expect(a.id).not.toBe(b.id);
      expect(b.id).not.toBe(c.id);
      expect(a.id).not.toBe(c.id);
    });

    it('assigns projectId immediately when a project store is provided', () => {
      const projectStore = {
        resolveForPath: vi.fn(() => ({ id: 'project-1' })),
        findByPath: vi.fn(() => ({ id: 'project-1' })),
        save: vi.fn(),
      } as any;
      const withProjects = new PlanManager(projectStore);

      const item = withProjects.create('/projects/backend', 'Build Auth', 'JWT middleware');

      expect(item.projectId).toBe('project-1');
      expect(projectStore.resolveForPath).toHaveBeenCalledWith('/projects/backend');
    });

    it('skips resolveForPath on load when item already has projectId', () => {
      const resolveForPath = vi.fn(() => ({ id: 'project-1' }));
      const findByPath = vi.fn(() => ({ id: 'project-1' }));
      const projectStore = { resolveForPath, findByPath, save: vi.fn() } as any;

      // Pre-load an item that already has projectId
      (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(['test.json']);
      (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'pre-existing',
        dirPath: '/projects/backend',
        title: 'Existing',
        description: '',
        status: 'pending',
        humanId: 'P-0001',
        projectId: 'project-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const withProjects = new PlanManager(projectStore);

      // Item already had projectId — ensurePlanMetadata skips resolveForPath.
      // recomputeStartable → resolveProjectId uses findByPath (read-only) once during construction.
      expect(resolveForPath).not.toHaveBeenCalled();
      expect(findByPath).toHaveBeenCalledTimes(1);

      // getForDirectory triggers resolveProjectId (findByPath) again (no caching at this layer).
      withProjects.getForDirectory('/projects/backend');
      expect(findByPath).toHaveBeenCalledTimes(2);
    });

    // Regression: a plan created in a project's non-canonical (alternate) folder
    // must roll up to the project and be visible when the planner queries by any
    // of the project's directories. Uses the REAL ProjectStore so create's
    // resolveForPath and list's findByPath resolve to the same project.
    describe('alternate-folder plans roll up to the project (regression)', () => {
      let projectStore: ProjectStore;
      let itemId: string;

      beforeEach(() => {
        projectStore = new ProjectStore();
        const project = projectStore.resolveForPath('/projects/app');
        projectStore.addDirectory(project.id, '/projects/app/sub-folder');
        const withProjects = new PlanManager(projectStore);
        itemId = withProjects.createWithType('/projects/app/sub-folder', 'Task', 'desc').id;
        pm = withProjects;
      });

      it('is returned when querying by the project canonical path', () => {
        expect(pm.getForDirectory('/projects/app').map((i) => i.id)).toContain(itemId);
      });

      it('is returned when querying by the folder path itself', () => {
        expect(pm.getForDirectory('/projects/app/sub-folder').map((i) => i.id)).toContain(itemId);
      });
    });
  });

  describe('update', () => {
    it('changes title only', () => {
      const item = pm.create('/d', 'Old', 'keep desc');
      const updated = pm.update(item.id, { title: 'New' });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('New');
      expect(updated!.description).toBe('keep desc');
    });

    it('changes description only', () => {
      const item = pm.create('/d', 'keep title', 'Old');
      const updated = pm.update(item.id, { description: 'New' });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('keep title');
      expect(updated!.description).toBe('New');
    });

    it('returns null for unknown ID', () => {
      expect(pm.update('nonexistent', { title: 'nope' })).toBeNull();
    });
  });

  describe('sequences', () => {
    it('assigns projectId to new sequences when a project store is provided', () => {
      const projectStore = {
        resolveForPath: vi.fn(() => ({ id: 'project-1' })),
        findByPath: vi.fn(() => ({ id: 'project-1' })),
        save: vi.fn(),
      } as any;
      const withProjects = new PlanManager(projectStore);

      const sequence = withProjects.createSequence('/d', 'Mission', 'Ship the thing', 'Remember constraints');

      expect(sequence.projectId).toBe('project-1');
      expect(projectStore.resolveForPath).toHaveBeenCalledWith('/d');
    });

    it('creates sequences and assigns plans in the same directory', () => {
      const item = pm.create('/d', 'Step', 'Do it');
      const sequence = pm.createSequence('/d', 'Mission', 'Ship the thing', 'Remember constraints');

      const assigned = pm.assignSequence(item.id, sequence.id);

      expect(sequence).toMatchObject({
        dirPath: '/d',
        title: 'Mission',
        missionStatement: 'Ship the thing',
        sharedMemory: 'Remember constraints',
      });
      expect(assigned?.sequenceId).toBe(sequence.id);
      expect(pm.getSequencesForDirectory('/d')).toEqual([sequence]);
      expect(persistence.savePlanSequences).toHaveBeenCalledWith(expect.arrayContaining([sequence]));
    });

    it('rejects sequence assignment across directories', () => {
      const item = pm.create('/a', 'Step', 'Do it');
      const sequence = pm.createSequence('/b', 'Other mission');

      expect(pm.assignSequence(item.id, sequence.id)).toBeNull();
      expect(pm.getItem(item.id)?.sequenceId).toBeUndefined();
    });

    it('allows sequence assignment across worktrees when both belong to one project', () => {
      const projectStore = {
        resolveForPath: vi.fn((dirPath: string) => ({
          id: dirPath.includes('repo') ? 'project-1' : 'project-2',
        })),
        findByPath: vi.fn((dirPath: string) => ({
          id: dirPath.includes('repo') ? 'project-1' : 'project-2',
        })),
        save: vi.fn(),
      } as any;
      const withProjects = new PlanManager(projectStore);
      const item = withProjects.create('X:\\coding\\repo-a', 'Step', 'Do it');
      const sequence = withProjects.createSequence('X:\\coding\\repo-b', 'Shared mission');

      const assigned = withProjects.assignSequence(item.id, sequence.id);

      expect(assigned?.sequenceId).toBe(sequence.id);
    });

    it('deletes only the empty sequences of the directory', () => {
      const item = pm.create('/d', 'Step', 'Do it');
      const used = pm.createSequence('/d', 'Used');
      pm.assignSequence(item.id, used.id);
      const empty = pm.createSequence('/d', 'Empty');
      const elsewhere = pm.createSequence('/other', 'Elsewhere');

      expect(pm.getEmptySequencesForDirectory('/d').map((s) => s.id)).toEqual([empty.id]);
      expect(pm.deleteEmptySequencesForDirectory('/d').map((s) => s.id)).toEqual([empty.id]);

      expect(pm.getSequence(empty.id)).toBeNull();
      expect(pm.getSequence(used.id)).not.toBeNull();
      expect(pm.getSequence(elsewhere.id)).not.toBeNull();
      expect(pm.getItem(item.id)?.sequenceId).toBe(used.id);
    });

    it('exports directory sequences with member plans', () => {
      const item = pm.create('/d', 'Step', 'Do it');
      const sequence = pm.createSequence('/d', 'Mission');
      pm.assignSequence(item.id, sequence.id);

      expect(pm.exportDirectory('/d')).toMatchObject({
        dirPath: '/d',
        items: [expect.objectContaining({ id: item.id, sequenceId: sequence.id })],
        sequences: [expect.objectContaining({ id: sequence.id, title: 'Mission' })],
      });
    });
  });

  describe('metadata migration', () => {
    it('assigns missing humanId and stateUpdatedAt when loading older plan files', () => {
      (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(['legacy.json']);
      (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'legacy-id',
        dirPath: '/d',
        title: 'Legacy',
        description: 'Older plan',
        status: 'ready',
        createdAt: 100,
        updatedAt: 101,
      });

      pm = new PlanManager();

      expect(pm.getItem('legacy-id')).toMatchObject({
        humanId: expect.stringMatching(/^P-\d{4,}$/),
        stateUpdatedAt: 101,
      });
      expect(persistence.savePlanFile).toHaveBeenCalledWith(expect.objectContaining({
        id: 'legacy-id',
        humanId: expect.stringMatching(/^P-\d{4,}$/),
        stateUpdatedAt: 101,
      }));
    });

    it('resolves UUID and P-id plan references', () => {
      const item = pm.create('/d', 'Alias me', 'Resolve by either ID');

      expect(pm.resolveItemRef(item.id)).toEqual({ status: 'found', item });
      expect(pm.resolveItemRef(item.humanId!.toLowerCase())).toEqual({ status: 'found', item });
      expect(pm.resolveItemRef('P-9999')).toEqual({ status: 'missing' });
    });

    it('normalizes leading zeros in P-id references by numeric value', () => {
      const item = pm.create('/d', 'Padded alias', 'Resolve by numeric P-id');

      expect(item.humanId).toBe('P-0001');
      expect(pm.resolveItemRef('P-1')).toEqual({ status: 'found', item });
      expect(pm.resolveItemRef('P-001')).toEqual({ status: 'found', item });
      expect(pm.resolveItemRef('P-000001')).toEqual({ status: 'found', item });
    });

    it('keeps invalid mixed P-id formats missing', () => {
      pm.create('/d', 'Alias me', 'Resolve by either ID');

      expect(pm.resolveItemRef('P-001abc')).toEqual({ status: 'missing' });
      expect(pm.resolveItemRef('P-abc')).toEqual({ status: 'missing' });
    });

    it('normalizes P-0 to P-0000 when such a legacy humanId exists', () => {
      (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(['legacy.json']);
      (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'legacy-zero',
        humanId: 'P-0000',
        dirPath: '/d',
        title: 'Zero',
        description: 'Legacy zero id',
        status: 'ready',
        createdAt: 100,
        updatedAt: 101,
      });

      pm = new PlanManager();
      const item = pm.getItem('legacy-zero')!;

      expect(pm.resolveItemRef('P-0')).toEqual({ status: 'found', item });
      expect(pm.resolveItemRef('P-000000')).toEqual({ status: 'found', item });
    });

    it('continues allocating humanIds past P-9999 without rollover truncation', () => {
      (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(['legacy.json']);
      (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'legacy-id',
        humanId: 'P-10000',
        dirPath: '/d',
        title: 'Legacy',
        description: 'Older plan',
        status: 'ready',
        createdAt: 100,
        updatedAt: 101,
      });

      pm = new PlanManager();
      const created = pm.create('/d', 'Next', 'Still increments');

      expect(created.humanId).toBe('P-10001');
      expect(pm.resolveItemRef('P-10001')).toEqual({ status: 'found', item: created });
    });

    it('reports ambiguous P-id references', () => {
      (persistence.listPlanFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue(['a.json', 'b.json']);
      (persistence.loadPlanFile as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce({
          id: 'a',
          humanId: 'P-0042',
          dirPath: '/d',
          title: 'A',
          description: 'First',
          status: 'ready',
          createdAt: 100,
          updatedAt: 101,
        })
        .mockReturnValueOnce({
          id: 'b',
          humanId: 'P-0042',
          dirPath: '/d',
          title: 'B',
          description: 'Second',
          status: 'ready',
          createdAt: 100,
          updatedAt: 101,
        });

      pm = new PlanManager();

      expect(pm.resolveItemRef('P-0042')).toMatchObject({
        status: 'ambiguous',
        matches: [
          expect.objectContaining({ id: 'a' }),
          expect.objectContaining({ id: 'b' }),
        ],
      });
      expect(pm.resolveItemRef('P-42')).toMatchObject({
        status: 'ambiguous',
        matches: [
          expect.objectContaining({ id: 'a' }),
          expect.objectContaining({ id: 'b' }),
        ],
      });
    });
  });

  describe('delete', () => {
    it('removes item and returns true', () => {
      const item = pm.create('/d', 'Bye', 'gone');
      expect(pm.delete(item.id)).toBe(true);
      expect(pm.getForDirectory('/d')).toHaveLength(0);
    });

    it('rewires a simple dependency chain when deleting the middle item', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);

      pm.delete(b.id);

      const exported = pm.exportDirectory('/d');
      expect(exported?.dependencies).toEqual([{ fromId: a.id, toId: c.id }]);
      const cNow = pm.getItem(c.id);
      expect(cNow).not.toBeNull();
      expect(cNow!.status).toBe('planning');
    });

    it('rewires all valid parent and child dependency pairs', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const middle = pm.create('/d', 'Middle', '');
      const c = pm.create('/d', 'C', '');
      const d = pm.create('/d', 'D', '');
      pm.addDependency(a.id, middle.id);
      pm.addDependency(b.id, middle.id);
      pm.addDependency(middle.id, c.id);
      pm.addDependency(middle.id, d.id);

      pm.delete(middle.id);

      expect(pm.exportDirectory('/d')?.dependencies).toEqual(expect.arrayContaining([
        { fromId: a.id, toId: c.id },
        { fromId: a.id, toId: d.id },
        { fromId: b.id, toId: c.id },
        { fromId: b.id, toId: d.id },
      ]));
      expect(pm.exportDirectory('/d')?.dependencies).toHaveLength(4);
    });

    it('does not duplicate an existing rewired dependency', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);
      pm.addDependency(a.id, c.id);

      pm.delete(b.id);

      expect(pm.exportDirectory('/d')?.dependencies).toEqual([{ fromId: a.id, toId: c.id }]);
    });

    it('skips rewired links that would create a cycle', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);
      pm.addDependency(c.id, a.id);

      // The cycle candidate is rejected up front, so add the reverse edge by importing a legacy graph.
      pm.importAll({
        '/d': {
          dirPath: '/d',
          items: [a, b, c],
          dependencies: [
            { fromId: a.id, toId: b.id },
            { fromId: b.id, toId: c.id },
            { fromId: c.id, toId: a.id },
          ],
        },
      });

      pm.delete(b.id);

      expect(pm.exportDirectory('/d')?.dependencies).toEqual([{ fromId: c.id, toId: a.id }]);
    });

    it('skips rewired links across directories', () => {
      const a = pm.create('/a', 'A', '');
      const b = pm.create('/a', 'B', '');
      const c = pm.create('/c', 'C', '');
      pm.importAll({
        '/a': {
          dirPath: '/a',
          items: [a, b],
          dependencies: [
            { fromId: a.id, toId: b.id },
            { fromId: b.id, toId: c.id },
          ],
        },
        '/c': {
          dirPath: '/c',
          items: [c],
          dependencies: [],
        },
      });

      pm.delete(b.id);

      expect(pm.exportDirectory('/a')?.dependencies).toEqual([]);
      expect(pm.exportDirectory('/c')?.dependencies).toEqual([]);
    });

    it('returns false for unknown ID', () => {
      expect(pm.delete('nonexistent')).toBe(false);
    });

    it('recomputes startable for dependents after removal', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      // b should be pending (blocked by a)
      expect(pm.getItem(b.id)!.status).toBe('planning');

      // Delete a — b's blocker is gone, so b should become startable
      pm.delete(a.id);
      expect(pm.getItem(b.id)!.status).toBe('ready');
    });
  });

  // ─── Dependencies ──────────────────────────────────────

  describe('addDependency', () => {
    it('creates edge fromId→toId', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');

      const result = pm.addDependency(a.id, b.id);
      expect(result).toBe(true);
    });

    it('marks toId as pending if fromId is not done', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      expect(pm.getItem(b.id)!.status).toBe('planning');
    });

    it('rejects self-loop', () => {
      const a = pm.create('/d', 'A', '');
      expect(pm.addDependency(a.id, a.id)).toBe(false);
    });

    it('rejects cycle A→B→C→A', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');

      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);

      // C→A would create a cycle
      expect(pm.addDependency(c.id, a.id)).toBe(false);
    });

    it('allows diamond shape (A→C, B→C)', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');

      expect(pm.addDependency(a.id, c.id)).toBe(true);
      expect(pm.addDependency(b.id, c.id)).toBe(true);

      // c is pending because both a and b are not done
      expect(pm.getItem(c.id)!.status).toBe('planning');
    });
  });

  describe('removeDependency', () => {
    it('removes edge and returns true', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      expect(pm.removeDependency(a.id, b.id)).toBe(true);
    });

    it('recomputes startable after removal', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);
      expect(pm.getItem(b.id)!.status).toBe('planning');

      pm.removeDependency(a.id, b.id);
      expect(pm.getItem(b.id)!.status).toBe('ready');
    });

    it('returns false for unknown edge', () => {
      expect(pm.removeDependency('x', 'y')).toBe(false);
    });
  });

  // ─── Project Directory Resolution ─────────────────────────────

  describe('getDirectoryForProject', () => {
    // Regression: the directory used to be inferred by scanning plans/sequences, so a registered
    // project with no plans yet resolved to null and context_create could never succeed on it.
    it('resolves a registered project with no plans to its canonical path', () => {
      const projectStore = new ProjectStore();
      const project = projectStore.resolveForPath('/projects/fresh');

      // Assert against the store's canonical path — normalizeProjectPath is
      // platform-dependent (Windows resolves this to a drive-rooted path).
      expect(new PlanManager(projectStore).getDirectoryForProject(project.id)).toBe(project.canonicalPath);
    });
  });

  // ─── Startable Computation ─────────────────────────────

  describe('startable computation', () => {
    it('item with no deps is startable', () => {
      const item = pm.create('/d', 'Solo', '');
      expect(item.status).toBe('ready');
    });

    it('item with all deps done is startable', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      // Complete a
      pm.applyItem(a.id);
      pm.completeItem(a.id, 'Completed this task successfully');

      expect(pm.getItem(b.id)!.status).toBe('ready');
    });

    it('item with any dep not done is pending', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      pm.addDependency(a.id, c.id);
      pm.addDependency(b.id, c.id);

      // Complete a but not b
      pm.applyItem(a.id);
      pm.completeItem(a.id, 'Completed this task successfully');

      expect(pm.getItem(c.id)!.status).toBe('planning');
    });

    it('completing a dep cascades startable to dependents', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);

      // Complete a → b becomes startable
      pm.applyItem(a.id);
      pm.completeItem(a.id, 'Completed this task successfully');
      expect(pm.getItem(b.id)!.status).toBe('ready');
      expect(pm.getItem(c.id)!.status).toBe('planning');

      // Complete b → c becomes startable
      pm.applyItem(b.id);
      pm.completeItem(b.id, 'Completed this task successfully');
      expect(pm.getItem(c.id)!.status).toBe('ready');
    });
  });

  // ─── Lifecycle ─────────────────────────────────────────

  describe('applyItem', () => {
    it('transitions startable→coding', () => {
      const item = pm.create('/d', 'Task', '');
      const applied = pm.applyItem(item.id);

      expect(applied).not.toBeNull();
      expect(applied!.status).toBe('coding');
    });

    it('rejects non-startable items', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      // b is pending — cannot apply
      expect(pm.applyItem(b.id)).toBeNull();
    });
  });

  describe('completeItem', () => {
    it('transitions doing→done and cascades startable recompute', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      pm.applyItem(a.id);
      const completed = pm.completeItem(a.id, 'Completed this task successfully');

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('done');
      expect(pm.getItem(b.id)!.status).toBe('ready');
    });

    it('rejects non-doing items', () => {
      const item = pm.create('/d', 'Task', '');
      // item is startable, not doing
      expect(pm.completeItem(item.id)).toBeNull();
    });

    describe('completionNotes validation', () => {
      it('stores completionNotes when completing', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        const completed = pm.completeItem(item.id, 'Built the auth middleware with JWT validation');
        expect(completed).not.toBeNull();
        expect(completed!.completionNotes).toBe('Built the auth middleware with JWT validation');
        expect(pm.getItem(item.id)!.completionNotes).toBe('Built the auth middleware with JWT validation');
      });

      it('rejects missing completionNotes (undefined)', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        expect(pm.completeItem(item.id, undefined)).toBeNull();
        expect(pm.getItem(item.id)!.status).toBe('coding');
      });

      it('rejects empty completionNotes', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        expect(pm.completeItem(item.id, '')).toBeNull();
        expect(pm.getItem(item.id)!.status).toBe('coding');
      });

      it('rejects whitespace-only completionNotes', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        expect(pm.completeItem(item.id, '   ')).toBeNull();
        expect(pm.getItem(item.id)!.status).toBe('coding');
      });

      it('rejects completionNotes shorter than 10 characters', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        expect(pm.completeItem(item.id, 'Short')).toBeNull();
        expect(pm.getItem(item.id)!.status).toBe('coding');
      });

      it('trims completionNotes before storing', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        const completed = pm.completeItem(item.id, '  Padded completion notes  ');
        expect(completed!.completionNotes).toBe('Padded completion notes');
      });

      it('persists completionNotes to disk via savePlanFile', () => {
        const item = pm.create('/d', 'Task', '');
        pm.applyItem(item.id);
        pm.completeItem(item.id, 'Persisted completion notes');
        expect(persistence.savePlanFile).toHaveBeenCalledWith(
          expect.objectContaining({ completionNotes: 'Persisted completion notes' }),
        );
      });
    });
  });

  // ─── Directory Scoping ─────────────────────────────────

  describe('directory scoping', () => {
    it('getForDirectory returns only items for that dirPath', () => {
      pm.create('/frontend', 'FE task', '');
      pm.create('/backend', 'BE task', '');
      pm.create('/frontend', 'FE task 2', '');

      const fe = pm.getForDirectory('/frontend');
      expect(fe).toHaveLength(2);
      expect(fe.every(i => i.dirPath === '/frontend')).toBe(true);
    });

    it('aggregates same-project plans across worktrees when a project store is provided', () => {
      const projectStore = {
        resolveForPath: vi.fn((dirPath: string) => ({
          id: dirPath.includes('repo') ? 'project-1' : 'project-2',
        })),
        findByPath: vi.fn((dirPath: string) => ({
          id: dirPath.includes('repo') ? 'project-1' : 'project-2',
        })),
        save: vi.fn(),
      } as any;
      const withProjects = new PlanManager(projectStore);
      const a = withProjects.create('X:\\coding\\repo-a', 'A', '');
      const b = withProjects.create('X:\\coding\\repo-b', 'B', '');
      withProjects.create('X:\\coding\\other', 'C', '');

      const items = withProjects.getForDirectory('X:\\coding\\repo-a');

      expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(items).toHaveLength(2);
    });

    it('getStartableForDirectory returns only startable items', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);

      const startable = pm.getStartableForDirectory('/d');
      expect(startable).toHaveLength(1);
      expect(startable[0].id).toBe(a.id);
    });

    it('getAllDoingForDirectory returns active plans regardless of which session set them coding', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/other', 'C', '');
      pm.applyItem(a.id);
      pm.applyItem(b.id);
      pm.applyItem(c.id);

      const doing = pm.getAllDoingForDirectory('/d');
      expect(doing).toHaveLength(2);
      expect(doing.map(item => item.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    });

    it('plan items do not carry a sessionId field after applyItem', () => {
      const item = pm.create('/d', 'Task', '');
      const applied = pm.applyItem(item.id);
      expect(applied).not.toBeNull();
      expect(applied!).not.toHaveProperty('sessionId');
    });
  });

  describe('setState', () => {
    it('preserves blocked items during recompute', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);
      pm.applyItem(a.id);
      pm.setState(a.id, 'blocked', 'Waiting for review');
      pm.removeDependency(a.id, b.id);

      expect(pm.getItem(a.id)?.status).toBe('blocked');
      expect(pm.getItem(a.id)?.stateInfo).toBe('Waiting for review');
    });

    it('preserves question items during recompute', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);
      pm.applyItem(a.id);
      pm.setState(a.id, 'blocked', 'Need product input');
      pm.removeDependency(a.id, b.id);

      expect(pm.getItem(a.id)?.status).toBe('blocked');
      expect(pm.getItem(a.id)?.stateInfo).toBe('Need product input');
    });

    it('allows blocked to return to coding', () => {
      const item = pm.create('/d', 'Task', '');
      pm.applyItem(item.id);
      pm.setState(item.id, 'blocked', 'Waiting on CI');

      const updated = pm.setState(item.id, 'coding');
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('coding');
      expect(updated?.stateInfo).toBeUndefined();
    });

    it('allows moving back to planning or ready', () => {
      const blocker = pm.create('/d', 'Blocker', '');
      const item = pm.create('/d', 'Task', '');
      pm.addDependency(blocker.id, item.id);
      pm.setState(item.id, 'coding');

      const planning = pm.setState(item.id, 'planning');
      expect(planning?.status).toBe('planning');

      const readyItem = pm.create('/d', 'Ready task', '');
      pm.setState(readyItem.id, 'coding');
      const ready = pm.setState(readyItem.id, 'ready');
      expect(ready?.status).toBe('ready');
    });

    it('preserves an explicit planning state even when dependencies are satisfied', () => {
      const item = pm.create('/d', 'Task', '');

      const planning = pm.setState(item.id, 'planning');

      expect(planning?.status).toBe('planning');
      expect(pm.getItem(item.id)?.status).toBe('planning');
    });

    it('allows a startable planning item to move to coding', () => {
      const item = pm.create('/d', 'Task', '');
      pm.setState(item.id, 'planning');

      const coding = pm.setState(item.id, 'coding');

      expect(coding?.status).toBe('coding');
    });

    it('transitions through review and blocked states', () => {
      const item = pm.create('/d', 'Task', '');
      pm.applyItem(item.id);

      const review = pm.setState(item.id, 'review');
      expect(review?.status).toBe('review');

      const blocked = pm.setState(item.id, 'blocked', 'Waiting on review');
      expect(blocked?.status).toBe('blocked');
    });

    it('rejects done to pending', () => {
      const item = pm.create('/d', 'Task', '');
      pm.applyItem(item.id);
      pm.completeItem(item.id, 'Completed this task successfully');

      expect(pm.setState(item.id, 'planning')).toBeNull();
    });
  });

  // ─── Events ────────────────────────────────────────────

  describe('events', () => {
    it('emits plan:changed on create', () => {
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.create('/d', 'Test', '');

      expect(handler).toHaveBeenCalledWith('/d');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits plan:changed on update', () => {
      const item = pm.create('/d', 'Test', '');
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.update(item.id, { title: 'Updated' });

      expect(handler).toHaveBeenCalledWith('/d');
    });

    it('emits plan:changed on delete', () => {
      const item = pm.create('/d', 'Test', '');
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.delete(item.id);

      expect(handler).toHaveBeenCalledWith('/d');
    });

    it('emits plan:changed on addDependency', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.addDependency(a.id, b.id);

      expect(handler).toHaveBeenCalledWith('/d');
    });

    it('emits plan:changed on removeDependency', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      pm.addDependency(a.id, b.id);
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.removeDependency(a.id, b.id);

      expect(handler).toHaveBeenCalledWith('/d');
    });

    it('emits plan:changed on applyItem', () => {
      const item = pm.create('/d', 'Task', '');
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.applyItem(item.id);

      expect(handler).toHaveBeenCalledWith('/d');
    });

    it('emits plan:changed on completeItem', () => {
      const item = pm.create('/d', 'Task', '');
      pm.applyItem(item.id);
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.completeItem(item.id, 'Completed this task successfully');

      expect(handler).toHaveBeenCalledWith('/d');
    });
  });

  // ─── Export / Import ───────────────────────────────────

  describe('exportAll', () => {
    it('returns all directories plans', () => {
      pm.create('/frontend', 'FE', '');
      pm.create('/backend', 'BE', '');
      const a = pm.create('/frontend', 'FE2', '');
      const b = pm.create('/frontend', 'FE3', '');
      pm.addDependency(a.id, b.id);

      const exported = pm.exportAll();

      expect(Object.keys(exported)).toHaveLength(2);
      expect(exported['/frontend'].items).toHaveLength(3);
      expect(exported['/frontend'].dependencies).toHaveLength(1);
      expect(exported['/backend'].items).toHaveLength(1);
      expect(exported['/backend'].dependencies).toHaveLength(0);
    });
  });

  describe('importAll', () => {
    it('loads data and clears existing', () => {
      pm.create('/old', 'Old item', '');

      pm.importAll({
        '/new': {
          dirPath: '/new',
          items: [{
            id: 'imported-1',
            dirPath: '/new',
            title: 'Imported',
            description: 'From file',
            status: 'ready',
            createdAt: 1000,
            updatedAt: 1000,
          }],
          dependencies: [],
        },
      });

      expect(pm.getForDirectory('/old')).toHaveLength(0);
      expect(pm.getForDirectory('/new')).toHaveLength(1);
      expect(pm.getItem('imported-1')).not.toBeNull();
    });

    it('recomputes startable status after import', () => {
      pm.importAll({
        '/d': {
          dirPath: '/d',
          items: [
            { id: 'a', dirPath: '/d', title: 'A', description: '', status: 'done', createdAt: 1, updatedAt: 1 },
            { id: 'b', dirPath: '/d', title: 'B', description: '', status: 'planning', createdAt: 2, updatedAt: 2 },
          ],
          dependencies: [{ fromId: 'a', toId: 'b' }],
        },
      });

      // b's only dep (a) is done → b should be recomputed to startable
      expect(pm.getItem('b')!.status).toBe('ready');
    });
  });

  // ─── Edge Cases ────────────────────────────────────────

  describe('edge cases', () => {
    it('multiple directories are independent DAGs', () => {
      const fe = pm.create('/frontend', 'FE', '');
      const be = pm.create('/backend', 'BE', '');

      // Cross-dir dependency should be rejected (items not in same dir)
      expect(pm.addDependency(fe.id, be.id)).toBe(false);
    });

    it('detects long cycle A→B→C→D→A', () => {
      const a = pm.create('/d', 'A', '');
      const b = pm.create('/d', 'B', '');
      const c = pm.create('/d', 'C', '');
      const d = pm.create('/d', 'D', '');

      pm.addDependency(a.id, b.id);
      pm.addDependency(b.id, c.id);
      pm.addDependency(c.id, d.id);

      // D→A would create a cycle
      expect(pm.addDependency(d.id, a.id)).toBe(false);
    });

    it('completing last blocker makes multiple items startable simultaneously', () => {
      const blocker = pm.create('/d', 'Blocker', '');
      const x = pm.create('/d', 'X', '');
      const y = pm.create('/d', 'Y', '');
      const z = pm.create('/d', 'Z', '');

      pm.addDependency(blocker.id, x.id);
      pm.addDependency(blocker.id, y.id);
      pm.addDependency(blocker.id, z.id);

      expect(pm.getItem(x.id)!.status).toBe('planning');
      expect(pm.getItem(y.id)!.status).toBe('planning');
      expect(pm.getItem(z.id)!.status).toBe('planning');

      pm.applyItem(blocker.id);
      pm.completeItem(blocker.id, 'Completed this task successfully');

      expect(pm.getItem(x.id)!.status).toBe('ready');
      expect(pm.getItem(y.id)!.status).toBe('ready');
      expect(pm.getItem(z.id)!.status).toBe('ready');
    });
  });

  // ─── deleteCompletedForDirectory ──────────────────────

  describe('deleteCompletedForDirectory', () => {
    let pm: PlanManager;

    beforeEach(() => {
      pm = new PlanManager();
    });

    it('deletes only done items, leaves non-done items', () => {
      const done1 = pm.create('/proj', 'Done1', '');
      pm.applyItem(done1.id);
      pm.completeItem(done1.id, 'Completed this task successfully');

      const doing1 = pm.create('/proj', 'Doing1', '');
      pm.applyItem(doing1.id);

      const startable1 = pm.create('/proj', 'Startable1', '');

      pm.deleteCompletedForDirectory('/proj');

      expect(pm.getItem(done1.id)).toBeNull();
      expect(pm.getItem(doing1.id)).not.toBeNull();
      expect(pm.getItem(startable1.id)).not.toBeNull();
    });

    it('returns count of deleted items', () => {
      const a = pm.create('/proj', 'A', '');
      pm.applyItem(a.id);
      pm.completeItem(a.id, 'Completed this task successfully');

      const b = pm.create('/proj', 'B', '');
      pm.applyItem(b.id);
      pm.completeItem(b.id, 'Completed this task successfully');

      pm.create('/proj', 'C', '');

      expect(pm.deleteCompletedForDirectory('/proj')).toBe(2);
    });

    it('returns 0 when no done items exist', () => {
      pm.create('/proj', 'Active', '');
      const doing = pm.create('/proj', 'Doing', '');
      pm.applyItem(doing.id);

      expect(pm.deleteCompletedForDirectory('/proj')).toBe(0);
    });

    it('returns 0 for empty directory', () => {
      expect(pm.deleteCompletedForDirectory('/empty')).toBe(0);
    });

    it('emits plan:changed event', () => {
      const item = pm.create('/proj', 'Task', '');
      pm.applyItem(item.id);
      pm.completeItem(item.id, 'Completed this task successfully');

      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.deleteCompletedForDirectory('/proj');

      expect(handler).toHaveBeenCalledWith('/proj');
    });

    it('does not delete done items in other directories', () => {
      const inTarget = pm.create('/proj', 'Target', '');
      pm.applyItem(inTarget.id);
      pm.completeItem(inTarget.id, 'Completed this task successfully');

      const inOther = pm.create('/other', 'Other', '');
      pm.applyItem(inOther.id);
      pm.completeItem(inOther.id, 'Completed this task successfully');

      pm.deleteCompletedForDirectory('/proj');

      expect(pm.getItem(inTarget.id)).toBeNull();
      expect(pm.getItem(inOther.id)).not.toBeNull();
      expect(pm.getItem(inOther.id)!.status).toBe('done');
    });
  });

  describe('deleteForProject', () => {
    it('deletes plans, dependencies, and sequences owned by the project', () => {
      const projectStore = new ProjectStore((cwd, args) => {
        if (args.includes('--show-toplevel')) {
          if (cwd.includes('repo-a')) return 'X:\\coding\\repo-a';
          if (cwd.includes('repo-b')) return 'X:\\coding\\repo-b';
          return cwd;
        }
        if (args.includes('--git-common-dir') && cwd.includes('repo-a')) return 'X:\\coding\\repo-a\\.git';
        if (args.includes('--git-common-dir') && cwd.includes('repo-b')) return 'X:\\coding\\repo-b\\.git';
        return null;
      });
      const withProjects = new PlanManager(projectStore);
      const targetProject = projectStore.resolveForPath('X:\\coding\\repo-a');
      const targetA = withProjects.create('X:\\coding\\repo-a', 'A', '');
      const targetB = withProjects.create('X:\\coding\\repo-a', 'B', '');
      const other = withProjects.create('X:\\coding\\repo-b', 'Other', '');
      const sequence = withProjects.createSequence('X:\\coding\\repo-a', 'Seq');
      withProjects.assignSequence(targetA.id, sequence.id);
      withProjects.addDependency(targetA.id, targetB.id);

      const result = withProjects.deleteForProject(targetProject.id);

      expect(result.plansDeleted).toBe(2);
      expect(result.sequencesDeleted).toBe(1);
      expect(result.planIds).toEqual(expect.arrayContaining([targetA.id, targetB.id]));
      expect(withProjects.getItem(targetA.id)).toBeNull();
      expect(withProjects.getItem(targetB.id)).toBeNull();
      expect(withProjects.getItem(other.id)).not.toBeNull();
      expect(withProjects.getSequencesForDirectory('X:\\coding\\repo-a')).toEqual([]);
      expect(withProjects.exportDirectory('X:\\coding\\repo-b')?.dependencies).toEqual([]);
      expect(persistence.deletePlanFile).toHaveBeenCalledWith(targetA.id);
      expect(persistence.deletePlanFile).toHaveBeenCalledWith(targetB.id);
    });
  });

  describe('bulkAssignSequence', () => {
    it('assigns sequenceId to multiple plans in same dir', () => {
      const a = pm.create('/proj', 'A', '');
      const b = pm.create('/proj', 'B', '');
      const seq = pm.createSequence('/proj', 'my-seq');

      const count = pm.bulkAssignSequence([a.id, b.id], seq.id);

      expect(count).toBe(2);
      expect(pm.getItem(a.id)!.sequenceId).toBe(seq.id);
      expect(pm.getItem(b.id)!.sequenceId).toBe(seq.id);
      expect(persistence.savePlanFile).toHaveBeenCalledTimes(6);
    });

    it('returns 0 for empty planIds array', () => {
      expect(pm.bulkAssignSequence([], 'seq1')).toBe(0);
    });

    it('returns 0 for unknown plan id', () => {
      expect(pm.bulkAssignSequence(['ghost'], 'seq1')).toBe(0);
    });

    it('skips plans from a different dirPath', () => {
      const a = pm.create('/proj', 'A', '');
      const b = pm.create('/other', 'B', '');
      const seq = pm.createSequence('/proj', 's');

      const count = pm.bulkAssignSequence([a.id, b.id], seq.id);

      expect(count).toBe(1);
      expect(pm.getItem(a.id)!.sequenceId).toBe(seq.id);
      expect(pm.getItem(b.id)!.sequenceId).toBeUndefined();
    });

    it('accepts null sequenceId to unlink from sequence', () => {
      const a = pm.create('/proj', 'A', '');
      const seq = pm.createSequence('/proj', 's');
      pm.assignSequence(a.id, seq.id);

      const count = pm.bulkAssignSequence([a.id], null);

      expect(count).toBe(1);
      expect(pm.getItem(a.id)!.sequenceId).toBeUndefined();
    });

    it('skips plans when sequence dirPath does not match', () => {
      const a = pm.create('/proj', 'A', '');
      const seq = pm.createSequence('/other', 'wrong-dir');

      const count = pm.bulkAssignSequence([a.id], seq.id);

      expect(count).toBe(0);
      expect(pm.getItem(a.id)!.sequenceId).toBeUndefined();
    });

    it('emits plan:changed after successful update', () => {
      const a = pm.create('/proj', 'A', '');
      const seq = pm.createSequence('/proj', 's');
      const handler = vi.fn();
      pm.on('plan:changed', handler);

      pm.bulkAssignSequence([a.id], seq.id);

      expect(handler).toHaveBeenCalledWith('/proj');
    });
  });
  // ─── claimed item lookups ───────────────────────────────

  describe('claimed item lookups', () => {
    it('claimedItemFor sees a claimed item whatever its lifecycle status', () => {
      // ready is NOT an active status — claimedPlanFor (the "doing" lookup)
      // must keep excluding it, but the hook tracker needs to move a claimed
      // item from ready to coding on the first edit, so it must be able to
      // see the claim first.
      const item = pm.create('/proj', 'Claimed early', '');
      pm.setState(item.id, 'ready');
      pm.claimPlan(item.id, 'sess-1');

      expect(pm.claimedItemFor('sess-1')?.id).toBe(item.id);
      expect(pm.claimedPlanFor('sess-1')).toBeNull();
    });

    it('claimedItemFor ignores done and blocked claims — neither is resumable work', () => {
      const done = pm.create('/proj', 'Finished', '');
      pm.setState(done.id, 'ready');
      pm.setState(done.id, 'coding');
      pm.completeItem(done.id, 'a completed piece of work');
      pm.claimPlan(done.id, 'sess-1');

      const blocked = pm.create('/proj', 'Walled off', '');
      pm.setState(blocked.id, 'ready');
      pm.setState(blocked.id, 'blocked', 'waiting on upstream API');
      pm.claimPlan(blocked.id, 'sess-1');

      expect(pm.claimedItemFor('sess-1')).toBeNull();
    });

    it('claimedItemFor returns null for an unclaimed session', () => {
      expect(pm.claimedItemFor('nobody')).toBeNull();
    });
  });
});
