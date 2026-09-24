import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/session/persistence.js', () => ({
  loadPlanContexts: vi.fn(() => []),
  savePlanContexts: vi.fn(),
  loadPlanContextBindings: vi.fn(() => []),
  savePlanContextBindings: vi.fn(),
}));

import { ContextManager } from '../src/session/context-manager.js';
import * as persistence from '../src/session/persistence.js';

describe('ContextManager', () => {
  let manager: ContextManager;
  let planManager: {
    exportAll: ReturnType<typeof vi.fn>;
    getSequence: ReturnType<typeof vi.fn>;
    getItem: ReturnType<typeof vi.fn>;
    getProjectIdForDirectory: ReturnType<typeof vi.fn>;
    getDirectoryForProject: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    planManager = {
      exportAll: vi.fn(() => ({
        '/proj': {
          dirPath: '/proj',
          items: [],
          dependencies: [],
          sequences: [{ id: 'seq-1', projectId: 'project-1', dirPath: '/proj', title: 'Seq', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }],
        },
      })),
      getSequence: vi.fn((id: string) => id === 'seq-1'
        ? { id: 'seq-1', projectId: 'project-1', dirPath: '/proj', title: 'Seq', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }
        : null),
      getItem: vi.fn((id: string) => id === 'plan-1'
        ? { id: 'plan-1', projectId: 'project-1', dirPath: '/proj', title: 'Plan', description: '', status: 'planning', createdAt: 1, updatedAt: 1 }
        : null),
      getProjectIdForDirectory: vi.fn((dirPath: string) => dirPath === '/proj' ? 'project-1' : 'project-2'),
      getDirectoryForProject: vi.fn((projectId: string) => projectId === 'project-1' ? '/proj' : null),
    };
    (persistence.loadPlanContexts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (persistence.loadPlanContextBindings as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
    manager = new ContextManager(planManager as any);
  });

  it('creates and lists contexts by directory', () => {
    const created = manager.create('project-1', { title: 'Testing Strategy', type: 'Testing', permission: 'readonly' });
    expect(created.type).toBe('Testing');
    expect(created.projectId).toBe('project-1');
    expect(manager.listForProject('project-1')).toEqual([created]);
  });

  it('binds a context to a sequence and returns metadata', () => {
    const created = manager.create('project-1', { title: 'Knowledge Base', permission: 'readonly' });
    expect(manager.bind(created.id, 'sequence', 'seq-1')).toBe(true);
    expect(manager.getContextMetadataForSequence('seq-1')).toEqual([
      { id: created.id, title: 'Knowledge Base', type: 'Knowledge', permission: 'readonly' },
    ]);
  });

  it('binds a context directly to a plan', () => {
    const created = manager.create('project-1', { title: 'Testing Strategy', permission: 'readonly' });
    expect(manager.bind(created.id, 'plan', 'plan-1')).toBe(true);
    expect(manager.getPlanIdsForContext(created.id)).toEqual(['plan-1']);
    expect(manager.getContextMetadataForPlan('plan-1')).toEqual([
      { id: created.id, title: 'Testing Strategy', type: 'Knowledge', permission: 'readonly' },
    ]);
  });

  it('prevents cross-directory binding', () => {
    const created = manager.create('project-2', { title: 'Elsewhere' });
    expect(manager.bind(created.id, 'sequence', 'seq-1')).toBe(false);
  });

  it('appends only to writable contexts and enforces mutex', () => {
    const writable = manager.create('project-1', { title: 'Running Notes', permission: 'writable', content: 'Before' });
    expect(() => manager.append(writable.id, 'After', writable.updatedAt - 1)).toThrow('updated concurrently');
    const updated = manager.append(writable.id, 'After', writable.updatedAt);
    expect(updated.content).toBe('Before\n\nAfter');
  });

  it('rejects append for readonly contexts', () => {
    const readonly = manager.create('project-1', { title: 'Read Me', permission: 'readonly' });
    expect(() => manager.append(readonly.id, 'Nope')).toThrow('readonly');
  });

  it('deletes bindings when a context is deleted', () => {
    const created = manager.create('project-1', { title: 'Testing Strategy', permission: 'readonly' });
    manager.bind(created.id, 'sequence', 'seq-1');
    expect(manager.delete(created.id)).toBe(true);
    expect(manager.getContextMetadataForSequence('seq-1')).toEqual([]);
  });

  it('persists positions', () => {
    const created = manager.create('project-1', { title: 'Visual Anchor', x: 10, y: 20 });
    const updated = manager.setPosition(created.id, 30, 40);
    expect(updated.x).toBe(30);
    expect(updated.y).toBe(40);
  });

  it('updates context fields and returns the updated node', () => {
    const created = manager.create('project-1', { title: 'Draft', type: 'Knowledge', permission: 'readonly', content: 'old' });
    const updated = manager.update(created.id, { title: 'Revised', type: 'Architecture', permission: 'writable', content: 'new' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Revised');
    expect(updated!.type).toBe('Architecture');
    expect(updated!.permission).toBe('writable');
    expect(updated!.content).toBe('new');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(manager.get(created.id)).toEqual(updated);
  });

  it('update() succeeds when expectedUpdatedAt matches current updatedAt', () => {
    const ctx = manager.create('project-1', { title: 'Node', permission: 'writable', content: 'v1' });
    const result = manager.update(ctx.id, { content: 'v2' }, ctx.updatedAt);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('v2');
  });

  it('update() throws when expectedUpdatedAt is stale', () => {
    const ctx = manager.create('project-1', { title: 'Node', permission: 'writable', content: 'v1' });
    expect(() => manager.update(ctx.id, { content: 'v2' }, ctx.updatedAt - 1)).toThrow('updated concurrently');
  });

  it('update() succeeds when expectedUpdatedAt is omitted', () => {
    const ctx = manager.create('project-1', { title: 'Node', permission: 'writable', content: 'v1' });
    const result = manager.update(ctx.id, { content: 'v2' });
    expect(result).not.toBeNull();
    expect(result!.content).toBe('v2');
  });

  it('unlinks a single binding without deleting the context', () => {
    const created = manager.create('project-1', { title: 'Shared Notes', permission: 'readonly' });
    manager.bind(created.id, 'sequence', 'seq-1');
    manager.bind(created.id, 'plan', 'plan-1');
    expect(manager.getSequenceIdsForContext(created.id)).toEqual(['seq-1']);
    expect(manager.getPlanIdsForContext(created.id)).toEqual(['plan-1']);

    expect(manager.unbind(created.id, 'sequence', 'seq-1')).toBe(true);
    expect(manager.getSequenceIdsForContext(created.id)).toEqual([]);
    expect(manager.getPlanIdsForContext(created.id)).toEqual(['plan-1']);
    expect(manager.get(created.id)).not.toBeNull();
  });

  it('returns false when unbinding a non-existent binding', () => {
    const created = manager.create('project-1', { title: 'Solo', permission: 'readonly' });
    expect(manager.unbind(created.id, 'sequence', 'seq-1')).toBe(false);
  });

  it('creates and manages orphan contexts with zero bindings', () => {
    const orphan = manager.create('project-1', { title: 'Free-floating Note', type: 'Knowledge', permission: 'writable', content: 'Standalone' });
    expect(manager.listForProject('project-1')).toEqual([orphan]);
    expect(manager.getSequenceIdsForContext(orphan.id)).toEqual([]);
    expect(manager.getPlanIdsForContext(orphan.id)).toEqual([]);
    expect(manager.getContextMetadataForSequence('seq-1')).toEqual([]);
    expect(manager.getContextMetadataForPlan('plan-1')).toEqual([]);

    const appended = manager.append(orphan.id, 'More text', orphan.updatedAt);
    expect(appended.content).toBe('Standalone\n\nMore text');

    expect(manager.delete(orphan.id)).toBe(true);
    expect(manager.listForProject('project-1')).toEqual([]);
  });

  it('removeBindingsForTarget removes all bindings for a deleted sequence', () => {
    const ctx1 = manager.create('project-1', { title: 'A', permission: 'readonly' });
    const ctx2 = manager.create('project-1', { title: 'B', permission: 'readonly' });
    manager.bind(ctx1.id, 'sequence', 'seq-1');
    manager.bind(ctx2.id, 'sequence', 'seq-1');
    manager.bind(ctx1.id, 'plan', 'plan-1');

    const removed = manager.removeBindingsForTarget('sequence', 'seq-1');
    expect(removed).toBe(2);
    expect(manager.getSequenceIdsForContext(ctx1.id)).toEqual([]);
    expect(manager.getSequenceIdsForContext(ctx2.id)).toEqual([]);
    expect(manager.getPlanIdsForContext(ctx1.id)).toEqual(['plan-1']);
  });

  it('removeBindingsForTarget removes all bindings for a deleted plan', () => {
    const ctx = manager.create('project-1', { title: 'A', permission: 'readonly' });
    manager.bind(ctx.id, 'plan', 'plan-1');
    manager.bind(ctx.id, 'sequence', 'seq-1');

    const removed = manager.removeBindingsForTarget('plan', 'plan-1');
    expect(removed).toBe(1);
    expect(manager.getPlanIdsForContext(ctx.id)).toEqual([]);
    expect(manager.getSequenceIdsForContext(ctx.id)).toEqual(['seq-1']);
  });

  it('removeBindingsForTarget returns 0 and is a no-op when target has no bindings', () => {
    const removed = manager.removeBindingsForTarget('sequence', 'nonexistent');
    expect(removed).toBe(0);
  });

  it('removeBindingsForTarget persists and emits context:changed', () => {
    const ctx = manager.create('project-1', { title: 'A', permission: 'readonly' });
    manager.bind(ctx.id, 'sequence', 'seq-1');
    const persistSpy = vi.mocked(persistence.savePlanContextBindings);
    const callsBefore = persistSpy.mock.calls.length;
    const emitted: string[] = [];
    manager.on('context:changed', (projectId: string) => emitted.push(projectId));

    manager.removeBindingsForTarget('sequence', 'seq-1');

    expect(persistSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(emitted).toContain('project-1');
  });

  it('upgrades legacy sequence-only bindings on load', () => {
    const created = { id: 'ctx-1', dirPath: '/proj', title: 'Legacy', type: 'Knowledge', permission: 'readonly', content: '', x: null, y: null, createdAt: 1, updatedAt: 1 };
    (persistence.loadPlanContexts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([created]);
    (persistence.loadPlanContextBindings as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      { contextId: 'ctx-1', sequenceId: 'seq-1', createdAt: 5 },
    ]);
    manager = new ContextManager(planManager as any);

    expect(manager.getSequenceIdsForContext('ctx-1')).toEqual(['seq-1']);
    expect(manager.get('ctx-1')?.projectId).toBe('project-1');
  });

  it('deletes only the unreferenced contexts of the project', () => {
    const toSequence = manager.create('project-1', { title: 'Seq bound' });
    const toPlan = manager.create('project-1', { title: 'Plan bound' });
    const loose = manager.create('project-1', { title: 'Loose' });
    const otherProject = manager.create('project-2', { title: 'Other project' });
    manager.bind(toSequence.id, 'sequence', 'seq-1');
    manager.bind(toPlan.id, 'plan', 'plan-1');

    expect(manager.getUnreferencedForProject('project-1').map((c) => c.id)).toEqual([loose.id]);
    expect(manager.deleteUnreferencedForProject('project-1')).toBe(1);

    expect(manager.get(loose.id)).toBeNull();
    expect(manager.get(toSequence.id)).not.toBeNull();
    expect(manager.get(toPlan.id)).not.toBeNull();
    expect(manager.get(otherProject.id)).not.toBeNull();
  });
});
