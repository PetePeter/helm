import { describe, expect, it } from 'vitest';
import { chatOriginLabel, splitChatLinks } from '../renderer/chat-view.js';

describe('chat message presentation', () => {
  it('labels user turns by their origin namespace', () => {
    expect(chatOriginLabel({ originId: 'desktop:abc' })).toBe('Desktop');
    expect(chatOriginLabel({ originId: 'telegram:123:45' })).toBe('Telegram');
    expect(chatOriginLabel({ originId: 'phone-1:abc' })).toBe('Phone');
    expect(chatOriginLabel({})).toBeNull();
  });

  it('splits safe web links from plain text and keeps trailing punctuation out of the link', () => {
    expect(splitChatLinks('See https://example.com/path.')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/path', href: 'https://example.com/path' },
      { text: '.' },
    ]);
    expect(splitChatLinks('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
  });
});
