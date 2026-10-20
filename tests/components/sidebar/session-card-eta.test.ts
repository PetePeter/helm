/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';

function localTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}

function mountCard(eta: { at: number; setAt: number; note?: string; range?: { lo: number; hi: number; samples: number } }, elapsedText = '0:00:00:00') {
  return mount(SessionCard, {
    props: {
      session: { id: 's1', name: 'worker', cliType: 'claude-code', eta },
      navIndex: 0,
      sessionState: 'idle',
      activityLevel: 'idle',
      displayName: 'worker',
      artifactCount: 0,
      unreadChatCount: 0,
      loopContinues: 0,
      pendingSubagents: 0,
      elapsedText,
      workingPlanLabel: '',
      workingPlanTooltip: '',
      isActive: false,
      isFocused: false,
      focusColumn: 0,
      isEditing: false,
    } as never,
  });
}

describe('SessionCard ETA timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 11, 8));
  });

  afterEach(() => vi.useRealTimers());

  it('shows a local-time flag, relative tooltip, set time, and note', () => {
    const now = Date.now();
    const at = now + 3 * 60 * 60_000 + 20 * 60_000;
    const wrapper = mountCard({ at, setAt: now - 8 * 60_000, note: 'review build' });
    const timer = wrapper.find('.session-eta-timer');

    expect(timer.text()).toBe(`🏁 ${localTime(at)}`);
    expect(timer.attributes('title')).toBe(
      `ETA ${localTime(at)} (in 3h 20m) · no range yet · set ${localTime(now - 8 * 60_000)} · review build`,
    );
  });

  it('turns amber and ticks to a late timer using the existing elapsed-text update', async () => {
    const now = Date.now();
    const etaAt = now + 60_000;
    const wrapper = mountCard({ at: etaAt, setAt: now });
    const timer = wrapper.find('.session-eta-timer');
    expect(timer.text()).toBe(`🏁 ${localTime(etaAt)}`);

    vi.setSystemTime(new Date(now + 13 * 60_000));
    await wrapper.setProps({ elapsedText: '0:00:00:13' } as never);

    expect(timer.text()).toBe('🏁 late 12m');
    expect(timer.classes()).toContain('session-eta-timer--late');
    expect(timer.attributes('title')).toContain('(late 12m)');
  });

  it('appends the learned range as (~N) and spells it out in the tooltip', () => {
    const now = Date.now();
    const at = now + 30 * 60_000;
    const range = { lo: at - 10 * 60_000, hi: at + 20 * 60_000, samples: 12 };
    const timer = mountCard({ at, setAt: now, range }).find('.session-eta-timer');
    expect(timer.text()).toBe(`🏁 ${localTime(at)} (~15)`);
    expect(timer.attributes('title')).toContain(`80% range ${localTime(range.lo)}–${localTime(range.hi)} (12 past tasks)`);
  });

  it('says no range yet in the tooltip until enough history exists', () => {
    const now = Date.now();
    const timer = mountCard({ at: now + 30 * 60_000, setAt: now }).find('.session-eta-timer');
    expect(timer.text()).not.toContain('~');
    expect(timer.attributes('title')).toContain('no range yet');
  });
});
