import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NEW_ITEM_PULSE_MS,
  panePulses,
  startNewItemPulses,
  type NewItemSources,
} from '../../renderer/composables/useNewItemPulse.js';
import { PANE_ARTIFACTS, PANE_MEMORIES, PANE_MESS, PANE_PLAN_SCREEN } from '../../renderer/dock-types.js';

/** A hand-driven event source: each `fire*` plays one IPC event. */
function fakeSources() {
  const listeners = new Map<string, (event?: any) => void>();
  const on = (name: string) => (cb: (event?: any) => void) => {
    listeners.set(name, cb);
    return () => { listeners.delete(name); };
  };
  const sources: NewItemSources = {
    onMemoryChanged: on('memory'),
    onMessAppended: on('mess'),
    onArtifactCreated: on('artifact'),
    onPlanCreated: on('plan'),
  };
  const fire = (name: string, event?: unknown) => listeners.get(name)?.(event);
  return { sources, fire, listeners };
}

describe('new item pulse', () => {
  let stop: () => void;
  let fake: ReturnType<typeof fakeSources>;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeSources();
    stop = startNewItemPulses(fake.sources);
  });

  afterEach(() => {
    stop();
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('pulses the matching pane for each kind of new item', () => {
    fake.fire('memory', { type: 'create' });
    fake.fire('mess');
    fake.fire('artifact');
    fake.fire('plan');

    expect(panePulses(PANE_MEMORIES)).toHaveLength(1);
    expect(panePulses(PANE_MESS)).toHaveLength(1);
    expect(panePulses(PANE_ARTIFACTS)).toHaveLength(1);
    expect(panePulses(PANE_PLAN_SCREEN)).toHaveLength(1);
  });

  it('ignores memory edits, links and deletes', () => {
    for (const type of ['update', 'link', 'delete', undefined]) fake.fire('memory', { type });

    expect(panePulses(PANE_MEMORIES)).toHaveLength(0);
  });

  it('stacks quick pulses and drops each after the fade', () => {
    fake.fire('mess');
    vi.advanceTimersByTime(NEW_ITEM_PULSE_MS / 2);
    fake.fire('mess');
    expect(panePulses(PANE_MESS)).toHaveLength(2);

    vi.advanceTimersByTime(NEW_ITEM_PULSE_MS / 2);
    expect(panePulses(PANE_MESS)).toHaveLength(1);

    vi.advanceTimersByTime(NEW_ITEM_PULSE_MS / 2);
    expect(panePulses(PANE_MESS)).toHaveLength(0);
  });

  it('unsubscribes every source on stop', () => {
    stop();
    expect(fake.listeners.size).toBe(0);
  });
});
