import { describe, expect, it } from 'vitest';
import { chatOriginLabel, splitChatLinks } from '../renderer/chat-view.js';
import { MobileChatJournal } from '../src/mobile/mobile-chat-journal.js';

describe('chat message presentation', () => {
  it('labels user turns by their origin namespace', () => {
    expect(chatOriginLabel({ originId: 'desktop:abc' })).toBe('Desktop');
    expect(chatOriginLabel({ originId: 'phone-1:abc' })).toBe('Phone');
    expect(chatOriginLabel({})).toBeNull();
  });

  it('labels hydrated legacy Telegram turns as Telegram', () => {
    const journal = new MobileChatJournal();
    journal.hydrate({
      nextSeq: 2,
      entries: [{
        seq: 1,
        record: {
          sessionId: 's1',
          sessionName: 'work',
          text: 'legacy message',
          at: 1,
          originId: 'telegram:123:456',
        },
      }],
    });
    const savedTurn = journal.sessionEntries('s1')[0]?.record;

    expect(savedTurn?.originId).toBe('telegram:123:456');
    expect(chatOriginLabel(savedTurn!)).toBe('Telegram');
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
