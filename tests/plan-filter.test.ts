/**
 * Plan listing filters — filterPlanItems preset + HelmPlanService integration.
 * TDD: tests written first, implementation follows.
 *
 * Filter presets:
 *  - all:       every item, incl. done
 *  - active:    every non-done item (default)
 *  - startable: non-done items whose precursors are all done (or have none)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
}));

import { filterPlanItems } from '../src/types/plan.js';
import type { PlanItem, PlanDependency, PlanStatus } from '../src/types/plan.js';
import { PlanManager } from '../src/session/plan-manager.js';
import { HelmPlanService } from '../src/mcp/services/helm-plan-service.js';
import { normalizeProjectPath } from '../src/session/project-identity.js';

function item(id: string, status: PlanStatus): PlanItem {
  return {
    id,
    dirPath: '/d',
    title: id,
    description: '',
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('filterPlanItems', () => {
  const planning = item('a', 'planning');
  const ready = item('b', 'ready');
  const coding = item('c', 'coding');
  const review = item('d', 'review');
  const blocked = item('e', 'blocked');
  const done = item('f', 'done');
  const items = [planning, ready, coding, review, blocked, done];

  it("'all' returns every item including done", () => {
    expect(filterPlanItems(items, [], 'all')).toEqual(items);
  });

  it("'active' excludes done, keeps all other states", () => {
    const result = filterPlanItems(items, [], 'active');
    expect(result).toEqual([planning, ready, coding, review, blocked]);
    expect(result.some(i => i.status === 'done')).toBe(false);
  });

  describe("'startable'", () => {
    it('includes non-done items with no precursors, in any state', () => {
      // No dependencies at all → every non-done item is startable regardless of state.
      const result = filterPlanItems(items, [], 'startable');
      expect(result).toEqual([planning, ready, coding, review, blocked]);
    });

    it('includes an item whose precursors are all done', () => {
      const deps: PlanDependency[] = [{ fromId: 'f', toId: 'a' }]; // done → planning
      const result = filterPlanItems([planning, done], deps, 'startable');
      expect(result.map(i => i.id)).toEqual(['a']);
    });

    it('excludes an item with an incomplete precursor', () => {
      const deps: PlanDependency[] = [{ fromId: 'c', toId: 'a' }]; // coding → planning
      const result = filterPlanItems([planning, coding], deps, 'startable');
      // 'a' is blocked by unfinished 'c'; 'c' itself has no precursors → startable.
      expect(result.map(i => i.id)).toEqual(['c']);
    });

    it('never includes done items even when startable', () => {
      const result = filterPlanItems([done], [], 'startable');
      expect(result).toEqual([]);
    });

    it('includes a blocked-state item once its precursors complete', () => {
      const deps: PlanDependency[] = [{ fromId: 'f', toId: 'e' }]; // done → blocked
      const result = filterPlanItems([blocked, done], deps, 'startable');
      expect(result.map(i => i.id)).toEqual(['e']);
    });
  });
});

describe('HelmPlanService plan listing filters', () => {
  let pm: PlanManager;
  let service: HelmPlanService;
  // Create plans under the same normalized key the service resolves to.
  const dir = normalizeProjectPath('/proj');

  beforeEach(() => {
    pm = new PlanManager();
    service = new HelmPlanService(pm, {} as never, {} as never);
  });

  it('listPlans defaults to active (hides done)', () => {
    const a = pm.create(dir, 'Keep', 'desc');
    const b = pm.create(dir, 'Finish', 'desc');
    pm.applyItem(b.id, 'session-1');
    pm.completeItem(b.id, 'done and dusted');

    const ids = service.listPlans(dir).map(i => i.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("listPlans with filter 'all' includes done", () => {
    const b = pm.create(dir, 'Finish', 'desc');
    pm.applyItem(b.id, 'session-1');
    pm.completeItem(b.id, 'done and dusted');

    const ids = service.listPlans(dir, 'all').map(i => i.id);
    expect(ids).toContain(b.id);
  });

  it("listPlans with filter 'startable' returns the frontier only", () => {
    const first = pm.create(dir, 'First', 'desc');
    const second = pm.create(dir, 'Second', 'desc');
    pm.addDependency(first.id, second.id); // second blocked by first

    const ids = service.listPlans(dir, 'startable').map(i => i.id);
    expect(ids).toContain(first.id);
    expect(ids).not.toContain(second.id);
  });

  it('plansSummary honours the filter and still resolves blockedBy humanIds', () => {
    const first = pm.create(dir, 'First', 'desc');
    const second = pm.create(dir, 'Second', 'desc');
    pm.addDependency(first.id, second.id);

    const summary = service.plansSummary(dir, 'all');
    const secondSummary = summary.find(s => s.id === second.id)!;
    expect(secondSummary.blockedBy).toContain(first.humanId ?? first.id);
  });

  it('plansSummary carries the sequence id so a reader can group by lane', () => {
    // The phone board groups rows into sequence lanes and only ever asks for
    // the summary — the full records are far too large for its link — so the
    // lane has to ride this payload or the grouping has nothing to group by.
    const lane = pm.createSequence(dir, 'Lane');
    const grouped = pm.create(dir, 'Grouped', 'desc');
    const loose = pm.create(dir, 'Loose', 'desc');
    pm.assignSequence(grouped.id, lane.id);

    const summary = service.plansSummary(dir);
    expect(summary.find(s => s.id === grouped.id)!.sequenceId).toBe(lane.id);
    expect(summary.find(s => s.id === loose.id)!.sequenceId).toBeUndefined();
  });

  it('plansSummary names the session working a claimed plan', () => {
    const claimed = pm.create(dir, 'Claimed', 'desc');
    const loose = pm.create(dir, 'Loose', 'desc');
    pm.claimPlan(claimed.id, 's-1');

    const summary = service.plansSummary(dir, 'active', id => (id === 's-1' ? 'worker' : undefined));
    const row = summary.find(s => s.id === claimed.id)!;
    expect(row.sessionId).toBe('s-1');
    expect(row.sessionName).toBe('worker');
    expect(summary.find(s => s.id === loose.id)).not.toHaveProperty('sessionId');
  });

  it('plansSummary keeps the claim but drops the name of a session that is gone', () => {
    const claimed = pm.create(dir, 'Claimed', 'desc');
    pm.claimPlan(claimed.id, 's-gone');

    const row = service.plansSummary(dir, 'active', () => undefined).find(s => s.id === claimed.id)!;
    expect(row.sessionId).toBe('s-gone');
    expect(row).not.toHaveProperty('sessionName');
  });

  it('plansSummary never carries a description, which is the point of it', () => {
    pm.create(dir, 'First', 'a very long description that must not ride the wire');

    const row = service.plansSummary(dir)[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('description');
  });

  it('returns [] for a directory with no plans', () => {
    expect(service.listPlans(normalizeProjectPath('/empty'))).toEqual([]);
    expect(service.plansSummary(normalizeProjectPath('/empty'))).toEqual([]);
  });
});
