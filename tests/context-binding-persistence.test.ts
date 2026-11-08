/**
 * Regression: context bindings on a project that has sequences but no plan
 * items must survive a restart.
 *
 * ContextManager's orphan cleanup asked PlanManager.exportAll for the valid
 * target ids, but exportAll enumerates directories from plan *items* only — a
 * project with sequences and no items exported nothing, so every binding on
 * those sequences looked orphaned and was deleted and persisted.
 *
 * Real ProjectStore/PlanManager/ContextManager against the temp APPDATA that
 * tests/pinia-setup.ts installs.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PlanManager } from '../src/session/plan-manager.js';
import { ProjectStore } from '../src/session/project-store.js';
import { ContextManager } from '../src/session/context-manager.js';
import { getProfilePersistencePaths } from '../src/session/persistence-paths.js';

describe('context binding persistence', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const newPaths = () => {
    const root = mkdtempSync(join(tmpdir(), 'helm-context-binding-'));
    roots.push(root);
    return getProfilePersistencePaths(root);
  };

  it('keeps sequence bindings for a project with no plan items', () => {
    const dir = '/tmp/context-binding-planless';
    const paths = newPaths();
    const projectStore = new ProjectStore(paths.projectsFile);
    const planManager = new PlanManager(projectStore, paths);
    const sequence = planManager.createSequence(dir, 'Planless mission');
    const contexts = new ContextManager(planManager, paths);
    const context = contexts.create(sequence.projectId!, { title: 'Notes', content: 'keep me' });

    expect(contexts.bind(context.id, 'sequence', sequence.id)).toBe(true);

    const reloadedPlans = new PlanManager(new ProjectStore(paths.projectsFile), paths);
    const reloadedContexts = new ContextManager(reloadedPlans, paths);

    expect(reloadedPlans.getSequence(sequence.id)).not.toBeNull();
    expect(reloadedContexts.get(context.id)).not.toBeNull();
    expect(reloadedContexts.getBindingsForContext(context.id)).toHaveLength(1);
  });

  it('still drops a binding whose target no longer exists', () => {
    const dir = '/tmp/context-binding-orphan';
    const paths = newPaths();
    const projectStore = new ProjectStore(paths.projectsFile);
    const planManager = new PlanManager(projectStore, paths);
    const sequence = planManager.createSequence(dir, 'Doomed mission');
    const contexts = new ContextManager(planManager, paths);
    const context = contexts.create(sequence.projectId!, { title: 'Notes', content: '' });
    contexts.bind(context.id, 'sequence', sequence.id);

    planManager.deleteSequence(sequence.id);

    const reloadedContexts = new ContextManager(new PlanManager(new ProjectStore(paths.projectsFile), paths), paths);
    expect(reloadedContexts.getBindingsForContext(context.id)).toHaveLength(0);
  });
});
