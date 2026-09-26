/**
 * Desktop voice hotkey. The router only sees keydown, and key auto-repeat
 * makes a keyboard "hold" unreliable anyway, so the hotkey is a TOGGLE: press
 * to start talking, press again to send. Gamepad `voice-talk` stays true hold.
 */
import type { KeyHandler } from '../router.js';

export const VOICE_TALK_COMBO = 'ctrl+shift+space';

export function createVoiceKeyHandler(toggleTalk: () => void): KeyHandler {
  return {
    id: 'voice-talk',
    scope: 'global',
    handle: (ctx) => {
      if (ctx.combo !== VOICE_TALK_COMBO) return false;
      if (!ctx.event.repeat) toggleTalk();
      return true;
    },
  };
}
