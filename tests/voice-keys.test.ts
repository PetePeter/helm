/**
 * The desktop voice hotkey. The router is keydown-only, so the hotkey is a
 * toggle (press to talk, press again to send) rather than a hold.
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createVoiceKeyHandler, VOICE_TALK_COMBO } from '../renderer/keyboard/handlers/voice-keys';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers, type KeyContext } from '../renderer/keyboard/router';

function ctx(combo: string, repeat = false): KeyContext {
  return { combo, event: { repeat } as KeyboardEvent } as unknown as KeyContext;
}

describe('voice talk hotkey', () => {
  it('is a global handler that toggles talk on its combo', () => {
    let toggles = 0;
    const handler = createVoiceKeyHandler(() => { toggles += 1; });

    expect(handler.scope).toBe('global');
    expect(handler.handle(ctx(VOICE_TALK_COMBO))).toBe(true);
    expect(toggles).toBe(1);
  });

  it('ignores other keys and auto-repeat', () => {
    let toggles = 0;
    const handler = createVoiceKeyHandler(() => { toggles += 1; });

    expect(handler.handle(ctx('ctrl+shift+n'))).toBe(false);
    expect(handler.handle(ctx(VOICE_TALK_COMBO, true))).toBe(true);
    expect(toggles).toBe(0);
  });
});

describe('voice talk hotkey through the real router', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => { uninstall?.(); uninstall = null; resetKeyHandlers(); });

  function press(modalOpen: boolean): number {
    let toggles = 0;
    registerKeyHandler(createVoiceKeyHandler(() => { toggles += 1; }));
    uninstall = installKeyRouter({
      getActiveSessionId: () => null,
      getFocusedPane: () => null,
      isPaneVisible: () => false,
      isModalOpen: () => modalOpen,
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }));
    return toggles;
  }

  it('fires from the workspace', () => {
    expect(press(false)).toBe(1);
  });

  it('is blocked while a modal owns the keyboard, like the other workspace keys', () => {
    expect(press(true)).toBe(0);
  });
});
