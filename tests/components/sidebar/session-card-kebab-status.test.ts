/**
 * Session row menu and status icons, using the real SessionCard.
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';
import { contextMenu, getFormModalResolve } from '../../../renderer/stores/modal-bridge.js';
import { useLlmNotificationsStore } from '../../../renderer/stores/llmNotifications.js';
import { sessionsState } from '../../../renderer/stores/sessions-screen.js';

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
      unreadChatCount: 0,
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

beforeEach(() => {
  contextMenu.visible = false;
  sessionsState.stateDropdownSessionId = null;
  sessionsState.stateDropdownFocusIndex = 0;
  sessionsState.editingSessionId = null;
  sessionsState.renameDraft = '';
  sessionsState.renameSelectionStart = 0;
  sessionsState.renameSelectionEnd = 0;
});

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
    expect(icons(mountCard({ locked: true, frozen: true, keepWarm: true }))).toEqual(['🔒', '❄️', '⏰']);
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

  it('renders and moves state dropdown focus from the shared screen state', async () => {
    const w = mountCard();
    sessionsState.stateDropdownSessionId = 's1';
    sessionsState.stateDropdownFocusIndex = 2;
    await nextTick();

    const options = w.findAll('.session-state-option');
    expect(options).toHaveLength(5);
    expect(options[2].classes()).toContain('dropdown-focused');
    expect(options[4].classes()).toContain('active');

    sessionsState.stateDropdownFocusIndex = 1;
    await nextTick();
    expect(options[2].classes()).not.toContain('dropdown-focused');
    expect(options[1].classes()).toContain('dropdown-focused');
  });

  it('closes the shared dropdown state when an option is selected', async () => {
    const w = mountCard();
    sessionsState.stateDropdownSessionId = 's1';
    await nextTick();

    await w.findAll('.session-state-option')[2].trigger('click');

    expect(sessionsState.stateDropdownSessionId).toBeNull();
    expect(w.emitted('stateChange')?.[0]).toEqual(['s1', 'planning']);
  });

  it('binds rename draft and caret selection to the screen state', async () => {
    const w = mountCard({ name: 'worker' });
    await w.setProps({ isEditing: true });
    await nextTick();

    const input = w.get('.session-rename-input');
    expect((input.element as HTMLInputElement).value).toBe('worker');
    expect((input.element as HTMLInputElement).selectionStart).toBe(0);
    expect((input.element as HTMLInputElement).selectionEnd).toBe('worker'.length);

    await input.setValue('renamed');
    expect(sessionsState.renameDraft).toBe('renamed');

    sessionsState.renameSelectionStart = 3;
    sessionsState.renameSelectionEnd = 3;
    await nextTick();
    expect((input.element as HTMLInputElement).selectionStart).toBe(3);
    expect((input.element as HTMLInputElement).selectionEnd).toBe(3);
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
