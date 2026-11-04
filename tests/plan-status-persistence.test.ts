/**
 * Regression: plan statuses must survive a PlanManager restart.
 *
 * Real persistence (APPDATA is redirected to a temp dir by tests/pinia-setup.ts),
 * no persistence mocks — the bug was that loadFromDisk ran every saved status
 * through the legacy migration table, which knew nothing about the current
 * 'coding'/'review' names and silently downgraded them to 'planning' (then
 * recomputeStartable promoted them to 'ready'), losing worker claims with them.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PlanManager } from '../src/session/plan-manager.js';

describe('PlanManager status persistence round trip', () => {
  it('preserves coding/review statuses and the session claim across a reload', () => {
    const dir = '/tmp/plan-status-roundtrip';
    const pm = new PlanManager();
    const coding = pm.create(dir, 'Coding item', '');
    const review = pm.create(dir, 'Review item', '');

    expect(pm.setState(coding.id, 'coding')).not.toBeNull();
    expect(pm.setState(review.id, 'review')).not.toBeNull();
    pm.claimPlan(coding.id, 'worker-A');

    const reloaded = new PlanManager();

    expect(reloaded.getItem(coding.id)?.status).toBe('coding');
    expect(reloaded.getItem(review.id)?.status).toBe('review');
    expect(reloaded.claimedPlanFor('worker-A')?.id).toBe(coding.id);
  });

  it('preserves blocked stateInfo across a reload', () => {
    const dir = '/tmp/plan-status-roundtrip-blocked';
    const pm = new PlanManager();
    const item = pm.create(dir, 'Blocked item', '');
    pm.setState(item.id, 'blocked', 'Waiting on API key');

    const reloaded = new PlanManager();
    const loaded = reloaded.getItem(item.id);
    expect(loaded?.status).toBe('blocked');
    expect(loaded?.stateInfo).toBe('Waiting on API key');
  });

  it('preserves suggested status and source idea across a reload', () => {
    const dir = `/tmp/plan-status-suggested-${randomUUID()}`;
    const pm = new PlanManager();
    const suggested = pm.createSuggested(dir, 'Suggested item', 'Awaiting triage', 'idea-1');

    const reloaded = new PlanManager();

    expect(reloaded.getItem(suggested.id)).toMatchObject({ status: 'suggested', sourceIdeaId: 'idea-1' });
    expect(reloaded.getStartableForDirectory(dir)).toEqual([]);
    pm.delete(suggested.id);
  });

  it('still migrates legacy statuses on load', () => {
    const dir = '/tmp/plan-status-legacy';
    const pm = new PlanManager();
    const item = pm.create(dir, 'Legacy item', '');
    // Simulate a file written by an older build.
    const imported = pm.importItem({
      ...item,
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Legacy doing',
      status: 'doing' as never,
    });
    expect(imported?.status).toBe('coding');

    const question = pm.importItem({
      ...item,
      id: '11111111-2222-3333-4444-555555555556',
      title: 'Legacy question',
      status: 'question' as never,
      stateInfo: undefined,
    });
    expect(question?.status).toBe('blocked');
    expect(question?.stateInfo).toBe('Question pending');
  });
});
