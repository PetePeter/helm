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

function mountCard(session: Record<string, unknown> = {}, isFocused = false, focusColumn = 0) {
  return mount(SessionCard, {
    props: {
      session: { id: 's1', name: 'worker', cliType: 'claude-code', ...session },
      navIndex: 0,
      isFocused,
      focusColumn,
      isActive: false,
      isEditing: false,
      sessionState: 'idle',
      activityLevel: 'idle',
      draftCount: 0,
      artifactCount: 0,
      elapsedText: '0:00:00:00',
      isSnappedOut: false,
      llmNotifications: [],
      shortcutKey: null,
    } as never,
  });
}

const icons = (w: ReturnType<typeof mountCard>) =>
  w.findAll('.session-status-icons > span').map(s => s.text());

beforeEach(() => { contextMenu.visible = false; });

describe('SessionCard kebab and status icons', () => {
  it('the kebab opens the session menu for this row, without selecting it', async () => {
    const w = mountCard();
    await w.find('.session-kebab').trigger('click');
    expect(contextMenu).toMatchObject({ visible: true, mode: 'session', sourceSessionId: 's1' });
    expect(w.emitted('click')).toBeUndefined();
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

  it('an expired keep-warm shows no alarm clock', () => {
    expect(icons(mountCard({ keepWarmUntil: Date.now() - 1 }))).toEqual([]);
  });

  it('a locked session still cannot be closed', () => {
    expect(mountCard({ locked: true }).find('.session-close').attributes('disabled')).toBeDefined();
  });

  it('gamepad columns: 2 is the kebab, 3 is close', () => {
    expect(mountCard({}, true, 2).find('.session-kebab').classes()).toContain('card-col-focused');
    expect(mountCard({}, true, 3).find('.session-close').classes()).toContain('card-col-focused');
  });
});
