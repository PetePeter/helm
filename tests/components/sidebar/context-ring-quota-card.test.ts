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

  it('hides quota rows without fresh quota data', async () => {
    const none = await hoverCard(null);
    expect(document.querySelectorAll('.quota-row')).toHaveLength(0);
    none.unmount();
    const stale = await hoverCard(quota(10, 10, now - 60 * MIN));
    expect(document.querySelectorAll('.quota-row')).toHaveLength(0);
    stale.unmount();
  });
});
