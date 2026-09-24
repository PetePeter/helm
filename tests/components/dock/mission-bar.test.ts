/**
 * MissionBar.vue — the session's TL;DR pinned above its terminal.
 *
 * The IPC clients are real proxies over `window.helm`; only the preload
 * surface underneath them is faked.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MissionBar from '../../../renderer/components/dock/MissionBar.vue';
import { clampMissionBarHeight, MISSION_BAR_MIN_PX, MISSION_BAR_MAX_PX } from '../../../renderer/terminal/mission-bar-size.js';

let sessionSetMission: ReturnType<typeof vi.fn>;
let sessionSetMissionBarHeight: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionSetMission = vi.fn(async () => ({ success: true }));
  sessionSetMissionBarHeight = vi.fn(async () => ({ success: true }));
  (window as unknown as { helm: unknown }).helm = {
    sessions: { sessionSetMission, sessionSetMissionBarHeight },
  };
});

const aiMission = { text: 'Refactor the dock', setBy: 'ai' as const, setAt: Date.now() - 120_000 };

function mountBar(props: Record<string, unknown> = {}) {
  return mount(MissionBar, { props: { sessionId: 'sess-1', mission: aiMission, ...props }, attachTo: document.body });
}

describe('MissionBar.vue — display', () => {
  it('shows the label, text and a muted meta line', () => {
    const w = mountBar();
    expect(w.text()).toContain('◎ Mission');
    expect(w.find('.mission-bar__text').text()).toBe('Refactor the dock');
    expect(w.find('.mission-bar__meta').text()).toContain('by AI');
    expect(w.find('.mission-bar__meta').text()).toContain('2m');
    w.unmount();
  });

  it('renders AI-authored HTML as literal text, never markup', () => {
    const w = mountBar({ mission: { ...aiMission, text: '<img src=x onerror=alert(1)><b>bold</b>' } });
    const text = w.find('.mission-bar__text');
    expect(text.find('img').exists()).toBe(false);
    expect(text.find('b').exists()).toBe(false);
    expect(text.text()).toBe('<img src=x onerror=alert(1)><b>bold</b>');
    w.unmount();
  });

  it('shows the italic placeholder when there is no mission', () => {
    const w = mountBar({ mission: undefined });
    expect(w.find('.mission-bar__placeholder').text()).toBe(
      'No mission yet — the AI will set one, or click to write it.',
    );
    w.unmount();
  });
});

describe('MissionBar.vue — editing', () => {
  it('clicking the text opens a textarea with maxlength 500 and a live counter', async () => {
    const w = mountBar();
    await w.find('.mission-bar__text').trigger('click');
    const ta = w.find('textarea');
    expect(ta.exists()).toBe(true);
    expect(ta.attributes('maxlength')).toBe('500');
    expect(w.find('.mission-bar__counter').text()).toBe('17/500');
    await ta.setValue('abc');
    expect(w.find('.mission-bar__counter').text()).toBe('3/500');
    w.unmount();
  });

  it('Enter saves through IPC and closes the editor', async () => {
    const w = mountBar();
    await w.find('.mission-bar__edit').trigger('click');
    const ta = w.find('textarea');
    await ta.setValue('New direction');
    await ta.trigger('keydown', { key: 'Enter' });
    expect(sessionSetMission).toHaveBeenCalledWith('sess-1', 'New direction');
    await Promise.resolve();
    await w.vm.$nextTick();
    expect(w.find('textarea').exists()).toBe(false);
    w.unmount();
  });

  it('Shift+Enter does not save (it inserts a newline)', async () => {
    const w = mountBar();
    await w.find('.mission-bar__edit').trigger('click');
    await w.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(sessionSetMission).not.toHaveBeenCalled();
    expect(w.find('textarea').exists()).toBe(true);
    w.unmount();
  });

  it('Esc cancels without saving', async () => {
    const w = mountBar();
    await w.find('.mission-bar__edit').trigger('click');
    await w.find('textarea').setValue('discard me');
    await w.find('textarea').trigger('keydown', { key: 'Escape' });
    expect(sessionSetMission).not.toHaveBeenCalled();
    expect(w.find('textarea').exists()).toBe(false);
    expect(w.find('.mission-bar__text').text()).toBe('Refactor the dock');
    w.unmount();
  });

  it('keeps the editor open and shows the error when the save is rejected', async () => {
    sessionSetMission.mockResolvedValueOnce({ success: false, error: 'Mission cannot exceed 500 characters' });
    const w = mountBar();
    await w.find('.mission-bar__edit').trigger('click');
    await w.find('textarea').trigger('keydown', { key: 'Enter' });
    await Promise.resolve();
    await w.vm.$nextTick();
    expect(w.find('textarea').exists()).toBe(true);
    expect(w.find('.mission-bar__error').text()).toContain('500');
    w.unmount();
  });
});

describe('MissionBar resize', () => {
  it('clamps between one line and min(240px, 40% of the pane)', () => {
    expect(clampMissionBarHeight(5, 1000)).toBe(MISSION_BAR_MIN_PX);
    expect(clampMissionBarHeight(100, 1000)).toBe(100);
    expect(clampMissionBarHeight(1000, 1000)).toBe(MISSION_BAR_MAX_PX);
    expect(clampMissionBarHeight(300, 400)).toBe(160); // 40% of a short pane
    expect(clampMissionBarHeight(300, 0)).toBe(MISSION_BAR_MAX_PX); // unmeasured pane
    expect(clampMissionBarHeight(20, 50)).toBe(MISSION_BAR_MIN_PX); // never below one line
  });

  it('dragging the handle resizes (clamped) and persists the final height', async () => {
    const w = mountBar({ height: 60 });
    const handle = w.find('.mission-bar__resize');
    await handle.trigger('mousedown', { clientY: 100 });
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 130 }));
    await w.vm.$nextTick();
    expect((w.element as HTMLElement).style.height).toBe('90px');
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 5000 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientY: 5000 }));
    await w.vm.$nextTick();
    expect((w.element as HTMLElement).style.height).toBe(`${MISSION_BAR_MAX_PX}px`);
    expect(sessionSetMissionBarHeight).toHaveBeenCalledTimes(1);
    expect(sessionSetMissionBarHeight).toHaveBeenCalledWith('sess-1', MISSION_BAR_MAX_PX);
    w.unmount();
  });
});
