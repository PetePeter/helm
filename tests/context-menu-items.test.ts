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
  session: { locked: false, frozen: false, keepWarm: false, hidden: false },
};

const groups = (overrides: Partial<ContextMenuContext>) =>
  buildContextMenuGroups({ ...base, ...overrides });

const findItem = (items: ReturnType<typeof buildContextMenuGroups>, id: string) =>
  items.flatMap(group => group.items).find(item => item.id === id)!;

describe('buildContextMenuGroups', () => {
  it('shares common non-cursor groups while keeping Hide in the row menu', () => {
    const session = groups({ mode: 'session' });
    const terminal = groups({ mode: 'terminal' });

    expect(findItem(session, 'toggle-hidden').label).toContain('Hide');
    expect(terminal.flatMap(group => group.items).some(item => item.id === 'toggle-hidden')).toBe(false);
    expect(terminal.filter(group => group.title !== 'Cursor')).toEqual(
      session.map(group => ({
        ...group,
        items: group.items.filter(item => item.id !== 'toggle-hidden'),
      })).filter(group => group.items.length > 0),
    );
    expect(findItem(session, 'new-session').enabled).toBe(true);
  });

  it('labels the row action Show when the session is hidden', () => {
    const hidden = groups({ mode: 'session', session: { ...base.session, hidden: true } });

    expect(findItem(hidden, 'toggle-hidden').label).toContain('Show');
  });

  it('omits Hide and Show for a remote attached session row', () => {
    const remote = groups({ mode: 'session', session: { ...base.session, remote: true } });

    expect(remote.flatMap(group => group.items).some(item => item.id === 'toggle-hidden')).toBe(false);
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

  it('adds chat copy and paste actions without terminal-only selection actions', () => {
    const chat = groups({ mode: 'chat', hasSelection: true });
    const textGroup = chat.find(group => group.title === 'Text');

    expect(chat.filter(group => group.title !== 'Text')).toEqual(
      groups({ mode: 'session' }).map(group => ({
        ...group,
        items: group.items.filter(item => item.id !== 'toggle-hidden'),
      })).filter(group => group.items.length > 0),
    );
    expect(textGroup?.items.map(item => item.id)).toEqual(['copy', 'paste']);
    expect(textGroup?.items.find(item => item.id === 'copy')?.enabled).toBe(true);
    expect(textGroup?.items.find(item => item.id === 'paste')?.enabled).toBe(true);
    expect(chat.flatMap(group => group.items).some(item => item.id === 'new-session-with-selection')).toBe(false);

    const frozen = groups({ mode: 'chat', session: { ...base.session, frozen: true } });
    expect(frozen.find(group => group.title === 'Text')?.items.find(item => item.id === 'paste')?.enabled).toBe(false);
  });

  it('keeps common session controls grouped for frozen targets and disables delivery', () => {
    const frozen = { ...base.session, frozen: true };
    const session = groups({ mode: 'session', session: frozen, currentGroupName: 'Work' });
    const terminal = groups({ mode: 'terminal', session: frozen, currentGroupName: 'Work', hasSelection: true });

    expect(terminal.filter(group => group.title !== 'Cursor')).toEqual(
      session.map(group => ({
        ...group,
        items: group.items.filter(item => item.id !== 'toggle-hidden'),
      })).filter(group => group.items.length > 0),
    );
    expect(findItem(session, 'toggle-freeze').label).toMatch(/unfreeze/i);
    for (const id of ['rename-session', 'toggle-lock', 'toggle-keep-warm', 'move-to-group', 'remove-from-group']) {
      expect(findItem(session, id).enabled).toBe(true);
    }
    expect(findItem(terminal, 'copy').enabled).toBe(true);
    expect(findItem(terminal, 'new-session-with-selection').enabled).toBe(true);
    expect(findItem(terminal, 'paste').enabled).toBe(false);
  });

  it('disables session-targeted actions when the selected target no longer exists', () => {
    const missing = groups({ targetSessionId: null });
    for (const id of ['quick-compact', 'clone-session', 'switch-cli', 'rename-session', 'move-to-group']) {
      expect(findItem(missing, id).enabled).toBe(false);
    }
    expect(findItem(missing, 'new-session').enabled).toBe(true);
  });
});
