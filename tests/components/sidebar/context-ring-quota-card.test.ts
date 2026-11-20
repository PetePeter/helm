/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ContextRing from '../../../renderer/components/sidebar/ContextRing.vue';
import type { SessionQuotaUsageSnapshot } from '../../../src/types/session.js';

const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const MIN = 60_000;

function quota(fiveHourUsed: number, weeklyUsed: number, measuredAtEpochMs = now): SessionQuotaUsageSnapshot {
  return {
    fiveHour: { usedPercent: fiveHourUsed, resetsAtEpochMs: now + (3 * 60 + 12) * MIN },
    weekly: { usedPercent: weeklyUsed, resetsAtEpochMs: now + (6 * 24 + 4) * 60 * MIN },
    measuredAtEpochMs,
  };
}

async function hoverCard(quotaUsage: SessionQuotaUsageSnapshot | null) {
  const wrapper = mount(ContextRing, {
    attachTo: document.body,
    props: { activityLevel: 'idle', quotaUsage, contextHistory: [{ at: now, tokens: 1000 }], contextUsage: { tokens: 1000, window: 200_000 } },
  });
  await wrapper.trigger('mouseenter');
  return wrapper;
}

describe('ContextRing hover card quota rows', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('shows remaining 5h and weekly quota with reset times and ring levels', async () => {
    const wrapper = await hoverCard(quota(92, 6));
    const rows = document.querySelectorAll('.quota-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('5h');
    expect(rows[0].textContent).toContain('8%');
    expect(rows[0].textContent).toContain('resets in 3h 12m');
    expect(rows[0].classList.contains('level-hot')).toBe(true);
    expect((rows[0].querySelector('.quota-row__fill') as HTMLElement).style.width).toBe('8%');
    expect(rows[1].textContent).toContain('Week');
    expect(rows[1].textContent).toContain('94%');
    expect(rows[1].textContent).toContain('resets in 6d 4h');
    expect(rows[1].classList.contains('level-ok')).toBe(true);
    wrapper.unmount();
  });

  it('shows the burn rate, flags one that runs out before reset, and draws the graph', async () => {
    const usage = { ...quota(70, 6), history: [{ at: now - 60 * MIN, fiveHour: 60, weekly: 6 }] };
    const wrapper = await hoverCard(usage);
    const rows = document.querySelectorAll('.quota-row');
    expect(rows[0].textContent).toContain('10%/h · out in 3h 0m');
    expect(rows[0].querySelector('.quota-row__burn--hot')).not.toBeNull();
    expect(rows[1].textContent).toContain('lasts to reset');
    expect(document.querySelectorAll('.quota-graph polyline')).toHaveLength(2);
    wrapper.unmount();
  });

  it('hides quota rows without fresh quota data', async () => {
    const none = await hoverCard(null);
    expect(document.querySelectorAll('.quota-row')).toHaveLength(0);
    none.unmount();
    const stale = await hoverCard(quota(10, 10, now - 60 * MIN));
    expect(document.querySelectorAll('.quota-row')).toHaveLength(0);
    stale.unmount();
  });

  it('keeps a whole-pixel gap between the quota ring and the context ring', () => {
    for (const size of [14, 16]) {
      const wrapper = mount(ContextRing, { props: { activityLevel: 'idle', size, quotaUsage: quota(10, 10), contextUsage: { tokens: 1000, window: 200_000 } } });
      const thickness = Number(wrapper.attributes('style')!.match(/--ring-thickness: (\d+)px/)![1]);
      const quotaRadius = Number(wrapper.find('.quota-ring__arc').attributes('d')!.match(/ A([\d.]+)/)![1]);
      const gap = quotaRadius - thickness / 2 - size / 2;
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(Number.isInteger(gap)).toBe(true);
      wrapper.unmount();
    }
  });
});
