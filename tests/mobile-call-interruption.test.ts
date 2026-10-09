import { describe, expect, it } from 'vitest';
import { renderCallInterruption } from '../src/mobile/mobile-call-interruption.js';
import type { MobileCallInterruption } from '../src/mobile/mobile-envelope.js';

function report(text: string, characterOffset?: number): MobileCallInterruption {
  return { text, ...(characterOffset === undefined ? {} : { characterOffset }), queuedReplies: [] };
}

describe('renderCallInterruption', () => {
  it('keeps the sentence at its first character in cut and not-heard', () => {
    const text = 'First sentence. Second sentence begins here.';
    expect(renderCallInterruption(report(text, text.indexOf('Second')), 'stop')).toBe(
      'Call interruption report:\n' +
      'Heard (complete sentences only): First sentence.\n' +
      'Cut during: Second sentence begins here. (around “Second”; hint: TTS progress can run ahead of audio.)\n' +
      'Not heard from current reply: Second sentence begins here.\n' +
      'Not heard from queued replies:\n' +
      '- none\n' +
      "User's words: stop",
    );
  });

  it('does not claim the next sentence as heard when progress is in the separating whitespace', () => {
    const text = 'First sentence.  Second sentence.';
    expect(renderCallInterruption(report(text, text.indexOf('  ') + 1), 'stop')).toBe(
      'Call interruption report:\n' +
      'Heard (complete sentences only): First sentence.\n' +
      'Cut during: Second sentence. (word position unavailable).\n' +
      'Not heard from current reply: Second sentence.\n' +
      'Not heard from queued replies:\n' +
      '- none\n' +
      "User's words: stop",
    );
  });

  it.each(['at the end', 'negative', 'fractional'] as const)(
    'treats an offset %s as unknown and keeps the full reply not heard', (kind) => {
    const text = 'Entire reply, not measured.';
    const characterOffset = kind === 'at the end' ? text.length : kind === 'negative' ? -1 : 1.5;
    expect(renderCallInterruption(report(text, characterOffset), 'repeat')).toBe(
      'Call interruption report:\n' +
      'Heard (complete sentences only): none can be confirmed.\n' +
      'Cut during: position unknown; there is no usable TTS range.\n' +
      'Not heard from current reply: Entire reply, not measured.\n' +
      'Not heard from queued replies:\n' +
      '- none\n' +
      "User's words: repeat",
    );
  });

  it('does not split the decimal in a sentence when progress reaches out', () => {
    const text = 'Version 3.5 is out. Next.';
    expect(renderCallInterruption(report(text, text.indexOf('out') + 1), 'wait')).toBe(
      'Call interruption report:\n' +
      'Heard (complete sentences only): none confirmed.\n' +
      'Cut during: Version 3.5 is out. (around “out”; hint: TTS progress can run ahead of audio.)\n' +
      'Not heard from current reply: out. Next.\n' +
      'Not heard from queued replies:\n' +
      '- none\n' +
      "User's words: wait",
    );
  });
});
