/**
 * Session row menu and status icons, using the real SessionCard.
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';
import { contextMenu, getFormModalResolve } from '../../../renderer/stores/modal-bridge.js';
import { useLlmNotificationsStore } from '../../../renderer/stores/llmNotifications.js';

function mountCard(session: Record<string, unknown> = {}, isFocused = false, focusColumn = 0) {
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

  it('shows every status that applies, side by side', () => {
    expect(icons(mountCard())).toEqual([]);
    expect(icons(mountCard({ locked: true }))).toEqual(['🔒']);
    expect(icons(mountCard({ locked: true, frozen: true, keepWarmUntil: Date.now() + 60_000 }))).toEqual(['🔒', '❄️', '⏰']);
  });

  it('an expired keep-warm shows no alarm clock', () => {
    expect(icons(mountCard({ keepWarmUntil: Date.now() - 1 }))).toEqual([]);
  });

  it('a locked session still cannot be closed', () => {
    expect(mountCard({ locked: true }).find('.session-close').attributes('disabled')).toBeDefined();
  });

  it('shows context only through the ring — no inline graph or ctx/% text', () => {
    const card = mountCard({ contextUsage: { tokens: 18_400, window: 200_000 } });
    expect(card.find('.session-context-usage').exists()).toBe(false);
    expect(card.text()).not.toContain('ctx');
    expect(card.findComponent({ name: 'ContextRing' }).exists()).toBe(true);
  });

  it('gamepad columns: 2 is the kebab, 3 is close', () => {
    expect(mountCard({}, true, 2).find('.session-kebab').classes()).toContain('card-col-focused');
    expect(mountCard({}, true, 3).find('.session-close').classes()).toContain('card-col-focused');
  });
});

describe('SessionCard — ETA placement and user note', () => {
  it('renders the ETA on the name line, not the top row', () => {
    const w = mountCard({ eta: { at: Date.now() + 600_000, setAt: Date.now() } });
    expect(w.find('.session-name-line .session-eta-timer').exists()).toBe(true);
    expect(w.find('.session-top-row .session-eta-timer').exists()).toBe(false);
  });

  it('📝 → OK adds a note as the newest notification; Cancel adds nothing', async () => {
    const store = useLlmNotificationsStore();
    store.clear();
    const w = mountCard();

    await w.find('.session-note').trigger('click');
    getFormModalResolve()!(null);
    await flushPromises();
    expect(store.notifications).toHaveLength(0);

    store.add({ sessionId: 's1', title: 'Build done', content: 'green' });
    await w.find('.session-note').trigger('click');
    getFormModalResolve()!({ note: '  check copilot  ' });
    await flushPromises();
    expect(store.bySession.get('s1')?.[0]).toMatchObject({ kind: 'note', content: 'check copilot' });
  });
});
