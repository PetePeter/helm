/**
 * The `voice-talk` binding action: press starts recording, release of the SAME
 * button stops and sends. Real hold tracker over a fake talk controller.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createVoiceTalkHolds } from '../renderer/voice/voice-talk-binding';

let events: string[];
let holds: ReturnType<typeof createVoiceTalkHolds>;

beforeEach(() => {
  events = [];
  holds = createVoiceTalkHolds({
    startTalk: async () => { events.push('start'); },
    stopTalk: async () => { events.push('stop'); },
  });
});

describe('voice-talk hold binding', () => {
  it('maps press to start and release to stop', () => {
    holds.press('X');
    expect(holds.release('X')).toBe(true);
    expect(events).toEqual(['start', 'stop']);
  });

  it('ignores the release of a button that never started a talk', () => {
    expect(holds.release('Y')).toBe(false);
    expect(events).toEqual([]);
  });

  it('a repeated press while held does not restart recording', () => {
    holds.press('X');
    holds.press('X');
    holds.release('X');
    expect(events).toEqual(['start', 'stop']);
  });

  it('releaseAll stops a held talk (focus loss / window blur)', () => {
    holds.press('X');
    holds.releaseAll();
    expect(events).toEqual(['start', 'stop']);
    expect(holds.release('X')).toBe(false);
  });
});
