/**
 * Which actions a session menu offers. The row kebab (⋮) is the session's own
 * menu; right-clicking the terminal adds the text actions. A frozen session
 * takes no input, so either way it only offers what works without typing into
 * it — plus the way out.
 */
import { describe, it, expect } from 'vitest';
import { buildContextMenuItems, type ContextMenuContext } from '../renderer/modals/context-menu-items.js';

const base: ContextMenuContext = {
  mode: 'terminal', hasSelection: false, hasActiveSession: true, isSnappedOut: false, currentGroupName: null,
  session: { locked: false, frozen: false, keepWarm: false, hiddenFromOverview: false },
};
const ids = (ctx: Partial<ContextMenuContext>) =>
  buildContextMenuItems({ ...base, ...ctx }).filter(i => i.enabled).map(i => i.id);

describe('buildContextMenuItems', () => {
  it('a frozen session — kebab or terminal — offers only unfreeze, compact, clone, switch, cancel', () => {
    const frozen = { ...base.session, frozen: true };
    const short = ['unfreeze', 'quick-compact', 'clone-session', 'switch-cli', 'cancel'];
    expect(ids({ mode: 'session', session: frozen })).toEqual(short);
    expect(ids({ mode: 'terminal', session: frozen })).toEqual(short);
  });

  it('the kebab offers the session actions that used to be row buttons', () => {
    const got = ids({ mode: 'session' });
    for (const id of ['rename-session', 'toggle-lock', 'toggle-freeze', 'toggle-keep-warm', 'toggle-overview',
      'quick-compact', 'clone-session', 'switch-cli', 'cancel']) {
      expect(got).toContain(id);
    }
    expect(got).not.toContain('copy');
  });

  it('labels the toggles by their current state', () => {
    const items = buildContextMenuItems({ ...base, mode: 'session', session: { locked: true, frozen: false, keepWarm: true, hiddenFromOverview: true } });
    const label = (id: string) => items.find(i => i.id === id)!.label;
    expect(label('toggle-lock')).toMatch(/unlock/i);
    expect(label('toggle-keep-warm')).toMatch(/stop/i);
    expect(label('toggle-overview')).toMatch(/show/i);
  });

  it('the terminal menu keeps its text actions for a normal session', () => {
    expect(ids({ mode: 'terminal', hasSelection: true })).toContain('copy');
  });
});
