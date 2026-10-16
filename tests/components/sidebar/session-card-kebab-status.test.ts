/**
 * Session row: the kebab (⋮) replaces the old lock / freeze / eye / rename
 * buttons, and the row's state shows as icons centred on it — every one that
 * applies, side by side. Real SessionCard.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';
import { contextMenu } from '../../../renderer/stores/modal-bridge.js';

function mountCard(session: Record<string, unknown> = {}, isFocused = false, focusColumn = 0, isHiddenFromOverview = false) {
  return mount(SessionCard, {
    props: {
      session: { id: 's1', name: 'worker', cliType: 'claude-code', ...session },
      navIndex: 0,
      displayName: 'worker',
      isFocused,
      focusColumn,
      isActive: false,
      isEditing: false,
      sessionState: 'idle',
      activityLevel: 'idle',
      loopContinues: 0,
      pendingSubagents: 0,
      artifactCount: 0,
      elapsedText: '0:00:00:00',
      workingPlanLabel: '',
      workingPlanTooltip: '',
      isSnappedOut: false,
      llmNotifications: [],
      shortcutKey: null,
      isHiddenFromOverview,
    } as never,
  });
}

const icons = (w: ReturnType<typeof mountCard>) =>
  w.findAll('.session-status-icons > span').map(s => s.text());

beforeEach(() => { contextMenu.visible = false; });

describe('SessionCard menu and status icons', () => {
  it('the kebab opens the session menu for this row, without selecting it', async () => {
    const w = mountCard();
    await w.find('.session-kebab').trigger('click');
    expect(contextMenu).toMatchObject({ visible: true, mode: 'session', sourceSessionId: 's1' });
    expect(w.emitted('click')).toBeUndefined();
  });

  it('right-click opens the same session menu at the pointer without selecting the row', async () => {
    const w = mountCard();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 50,
    });

    const dispatchResult = w.find('.session-card').element.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(contextMenu).toMatchObject({
      visible: true,
      mode: 'session',
      sourceSessionId: 's1',
      position: { x: 30, y: 50 },
    });
    expect(w.emitted('click')).toBeUndefined();
  });

  it.each([
    ['read-only', { readOnly: true }],
    ['renaming', { isEditing: true }],
  ])('does not open the row menu when %s', async (_state, props) => {
    const w = mountCard();
    await w.setProps(props);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    w.find('.session-card').element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(contextMenu.visible).toBe(false);
  });

  it('keeps the row menu available when session interactions are disabled, like the kebab', async () => {
    const w = mountCard();
    await w.setProps({ interactionDisabled: true });
    await w.find('.session-card').trigger('contextmenu', { clientX: 30, clientY: 50 });

    expect(contextMenu).toMatchObject({ visible: true, mode: 'session', sourceSessionId: 's1' });
  });

  it('no longer carries separate lock / freeze / eye / rename buttons', () => {
    const w = mountCard();
    for (const cls of ['.session-lock', '.session-freeze', '.session-overview-toggle', '.session-rename']) {
      expect(w.find(cls).exists()).toBe(false);
    }
  });

  it('shows every status that applies, side by side', () => {
    expect(icons(mountCard())).toEqual([]);
    expect(icons(mountCard({ locked: true }))).toEqual(['🔒']);
    expect(icons(mountCard({ locked: true, frozen: true, keepWarmUntil: Date.now() + 60_000 }))).toEqual(['🔒', '❄️', '⏰']);
  });

  it('a session hidden from the overview shows a closed eye mid-row', () => {
    expect(mountCard().find('.session-status-hidden').exists()).toBe(false);
    const hidden = mountCard({ locked: true }, false, 0, true);
    expect(hidden.find('.session-status-icons .session-status-hidden').attributes('title')).toBe('Hidden from the overview');
    expect(icons(hidden)).toEqual(['🔒', '']);
  });

  it('an expired keep-warm shows no alarm clock', () => {
    expect(icons(mountCard({ keepWarmUntil: Date.now() - 1 }))).toEqual([]);
  });

  it('a locked session still cannot be closed', () => {
    expect(mountCard({ locked: true }).find('.session-close').attributes('disabled')).toBeDefined();
  });

  it('shows cached context usage with an optional percentage and exact tooltip', () => {
    const withWindow = mountCard({ contextUsage: { tokens: 18_400, window: 200_000 } });
    expect(withWindow.find('.session-context-usage').text()).toBe('ctx 18.4k · 9%');
    expect(withWindow.find('.session-context-usage').attributes('title')).toBe('18,400 context tokens · 9% of 200,000');

    const withoutWindow = mountCard({ contextUsage: { tokens: 850 } });
    expect(withoutWindow.find('.session-context-usage').text()).toBe('ctx 850');
    expect(withoutWindow.find('.session-context-usage').attributes('title')).toBe('850 context tokens');
  });

  it('gamepad columns: 2 is the kebab, 3 is close', () => {
    expect(mountCard({}, true, 2).find('.session-kebab').classes()).toContain('card-col-focused');
    expect(mountCard({}, true, 3).find('.session-close').classes()).toContain('card-col-focused');
  });
});
