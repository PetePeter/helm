/**
 * The bridge that replaced the second collapse system.
 *
 * Navigation used to ask `sidebar/section-collapse.ts` — module globals kept in
 * step with Vue refs by hand — whether a zone was collapsed. It now asks the
 * dock workspace, which is the only thing that actually knows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPaneVisible,
  resetPaneVisibilityBridge,
  setPaneVisibilityBridge,
} from '../renderer/dock-visibility-bridge';
import { useDockWorkspace } from '../renderer/composables/useDockWorkspace';
import { PANE_ARTIFACTS, PANE_QUICK_SPAWN, PANE_SCHEDULER } from '../renderer/dock-types';

afterEach(() => resetPaneVisibilityBridge());

describe('pane visibility bridge', () => {
  it('defaults to permissive so nav modules work without a shell', () => {
    expect(isPaneVisible(PANE_QUICK_SPAWN)).toBe(true);
  });

  it('answers from the installed predicate', () => {
    setPaneVisibilityBridge(paneId => paneId === PANE_SCHEDULER);
    expect(isPaneVisible(PANE_SCHEDULER)).toBe(true);
    expect(isPaneVisible(PANE_QUICK_SPAWN)).toBe(false);
  });

  it('reports the real workspace: a background tab and a collapsed dock are not visible', () => {
    const workspace = useDockWorkspace();
    setPaneVisibilityBridge(workspace.isVisible);

    // Classic puts Scheduler, Quick Spawn and Directories in one left group.
    expect(isPaneVisible(PANE_SCHEDULER)).toBe(true);
    expect(isPaneVisible(PANE_QUICK_SPAWN)).toBe(false);

    workspace.activate(PANE_QUICK_SPAWN);
    expect(isPaneVisible(PANE_QUICK_SPAWN)).toBe(true);
    expect(isPaneVisible(PANE_SCHEDULER)).toBe(false);

    // Artifacts starts behind a collapsed autohide rail.
    expect(isPaneVisible(PANE_ARTIFACTS)).toBe(false);
    workspace.reveal(PANE_ARTIFACTS);
    expect(isPaneVisible(PANE_ARTIFACTS)).toBe(true);
  });
});
