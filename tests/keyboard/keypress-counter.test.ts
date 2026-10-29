/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createKeypressCounter } from '../../renderer/keyboard/keypress-counter.js';
import { installKeyRouter, resetKeyHandlers } from '../../renderer/keyboard/router.js';
import { installDockKeyRouter } from '../../renderer/keyboard/install.js';
import { PANE_ARTIFACTS, PANE_DRAFT, PANE_PLAN_SCREEN, PANE_TERMINAL } from '../../renderer/dock-types.js';
import { planScreenState } from '../../renderer/plans/plan-screen.js';

afterEach(() => {
  vi.useRealTimers();
  resetKeyHandlers();
  delete (window as unknown as { helm?: unknown }).helm;
});

describe('desktop keypress counting', () => {
  it('counts keydown events, not pasted characters or auto-repeat, and preserves session and slot boundaries', () => {
    vi.useFakeTimers();
    let now = 0;
    let sessionId: string | null = 'a';
    const sent: Array<[string, number, number]> = [];
    const counter = createKeypressCounter((id, count, at) => sent.push([id, count, at]), () => now);
    const uninstall = installKeyRouter({
      getActiveSessionId: () => sessionId,
      getFocusedPane: () => PANE_TERMINAL,
      isPaneVisible: () => true,
      isModalOpen: () => false,
    }, (event, id) => counter.record(id, event));

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('paste', { bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true }));
    sessionId = 'b';
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    now = 5 * 60_000;
    sessionId = 'a';
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
    vi.advanceTimersByTime(5_000);

    expect(sent).toEqual([['a', 2, 0], ['b', 1, 0], ['a', 1, 5 * 60_000]]);
    uninstall();
  });

  it('sends counted keys through the dock keyboard installation', () => {
    setActivePinia(createPinia());
    const sent: Array<[string, number]> = [];
    (window as unknown as { helm: unknown }).helm = {
      time: { timeRecordKeys: async (id: string, count: number) => { sent.push([id, count]); } },
    };
    const uninstall = installDockKeyRouter({
      getActiveSessionId: () => 'session-a',
      getFocusedPane: () => PANE_TERMINAL,
      isPaneVisible: () => true,
      isPanelOpen: () => false,
    });

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.body.dispatchEvent(new Event('paste', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    uninstall();

    expect(sent).toEqual([['session-a', 1]]);
  });

  it('counts Draft and Artifact keys for the session and Plan keys for the viewed project', () => {
    setActivePinia(createPinia());
    let focusedPane = PANE_DRAFT;
    let activeSessionId: string | null = 'session-a';
    const sent: Array<[string | { dirPath: string }, number]> = [];
    planScreenState.currentDir = 'C:/plans-project';
    (window as unknown as { helm: unknown }).helm = {
      time: { timeRecordKeys: async (target: string | { dirPath: string }, count: number) => { sent.push([target, count]); } },
    };
    const uninstall = installDockKeyRouter({
      getActiveSessionId: () => activeSessionId,
      getFocusedPane: () => focusedPane,
      isPaneVisible: () => true,
      isPanelOpen: () => false,
    });

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    focusedPane = PANE_ARTIFACTS;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    focusedPane = PANE_PLAN_SCREEN;
    activeSessionId = null;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    document.body.dispatchEvent(new Event('paste', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    uninstall();

    expect(sent).toEqual([['session-a', 2], [{ dirPath: 'C:/plans-project' }, 1]]);
    planScreenState.currentDir = '';
  });
});
