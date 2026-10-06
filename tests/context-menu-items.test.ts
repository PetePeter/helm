import { describe, expect, it } from 'vitest';
import {
  buildContextMenuGroups,
  type ContextMenuContext,
} from '../renderer/modals/context-menu-items.js';

const base: ContextMenuContext = {
  mode: 'terminal',
  targetSessionId: 'session-1',
  hasSelection: false,
  isSnappedOut: false,
  currentGroupName: null,
  session: { locked: false, frozen: false, keepWarm: false, hiddenFromOverview: false },
};

const groups = (overrides: Partial<ContextMenuContext>) =>
  buildContextMenuGroups({ ...base, ...overrides });

const findItem = (items: ReturnType<typeof buildContextMenuGroups>, id: string) =>
  items.flatMap(group => group.items).find(item => item.id === id)!;

describe('buildContextMenuGroups', () => {
  it('shares every non-cursor group between the kebab and terminal menus', () => {
    const session = groups({ mode: 'session' });
    const terminal = groups({ mode: 'terminal' });

    expect(terminal.filter(group => group.title !== 'Cursor')).toEqual(session);
    expect(findItem(session, 'editor').enabled).toBe(true);
    expect(findItem(session, 'prompts').enabled).toBe(true);
    expect(findItem(session, 'drafts').enabled).toBe(true);
    expect(findItem(session, 'new-session').enabled).toBe(true);
  });

  it('adds cursor actions only to the terminal menu and gates selection actions', () => {
    const session = groups({ mode: 'session', hasSelection: true });
    const terminal = groups({ mode: 'terminal' });

    expect(session.some(group => group.title === 'Cursor')).toBe(false);
    expect(findItem(terminal, 'copy').enabled).toBe(false);
    expect(findItem(terminal, 'new-session-with-selection').enabled).toBe(false);
    expect(findItem(terminal, 'paste').enabled).toBe(true);

    const selected = groups({ mode: 'terminal', hasSelection: true });
    expect(findItem(selected, 'copy').enabled).toBe(true);
    expect(findItem(selected, 'new-session-with-selection').enabled).toBe(true);
  });

  it('keeps common session controls grouped for frozen targets and disables delivery', () => {
    const frozen = { ...base.session, frozen: true };
    const session = groups({ mode: 'session', session: frozen, currentGroupName: 'Work' });
    const terminal = groups({ mode: 'terminal', session: frozen, currentGroupName: 'Work', hasSelection: true });

    expect(terminal.filter(group => group.title !== 'Cursor')).toEqual(session);
    expect(findItem(session, 'toggle-freeze').label).toMatch(/unfreeze/i);
    for (const id of ['rename-session', 'toggle-lock', 'toggle-keep-warm', 'toggle-overview', 'move-to-group', 'remove-from-group']) {
      expect(findItem(session, id).enabled).toBe(true);
    }
    for (const id of ['editor', 'prompts', 'drafts']) expect(findItem(session, id).enabled).toBe(false);
    expect(findItem(terminal, 'copy').enabled).toBe(true);
    expect(findItem(terminal, 'new-session-with-selection').enabled).toBe(true);
    expect(findItem(terminal, 'paste').enabled).toBe(false);
  });

  it('disables session-targeted actions when the selected target no longer exists', () => {
    const missing = groups({ targetSessionId: null });
    for (const id of ['quick-compact', 'editor', 'prompts', 'drafts', 'clone-session', 'switch-cli', 'rename-session', 'move-to-group']) {
      expect(findItem(missing, id).enabled).toBe(false);
    }
    expect(findItem(missing, 'new-session').enabled).toBe(true);
  });
});
