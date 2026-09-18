/**
 * MobileChatJournal — the ONE rolling record of every chat message fanned out to
 * phones, and the seq cursor catch-up is replayed from.
 *
 * Real journal, injected clock, injected persist sink — no disk, no timers.
 */

import { describe, it, expect } from 'vitest';
import { MobileChatJournal } from '../src/mobile/mobile-chat-journal';
import type { ChatJournalState } from '../src/mobile/mobile-chat-journal';

const HOUR = 3_600_000;

function record(text: string, at: number) {
  return { sessionId: 's1', sessionName: 'work', text, at };
}

describe('MobileChatJournal sequencing', () => {
  it('appends with a monotonic seq, oldest first', () => {
    const journal = new MobileChatJournal({ now: () => 0 });

    const first = journal.append(record('one', 0));
    const second = journal.append(record('two', 1));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['one', 'two']);
    expect(journal.since(1).map(entry => entry.record.text)).toEqual(['two']);
    expect(journal.since(2)).toEqual([]);
    expect(journal.latestSeq()).toBe(2);
  });

  it('persists the counter across a reload, so a seq is never reused', () => {
    let saved: ChatJournalState | undefined;
    const journal = new MobileChatJournal({
      now: () => 0,
      persist: (state) => { saved = state; },
    });
    journal.append(record('one', 0));
    journal.append(record('two', 1));

    const reloaded = new MobileChatJournal({ now: () => 0 });
    reloaded.hydrate(saved);

    expect(reloaded.latestSeq()).toBe(2);
    expect(reloaded.append(record('three', 2)).seq).toBe(3);
  });

  it('carries the entries themselves across a reload', () => {
    let saved: ChatJournalState | undefined;
    const journal = new MobileChatJournal({ now: () => 0, persist: (state) => { saved = state; } });
    journal.append(record('one', 0));

    const reloaded = new MobileChatJournal({ now: () => 0 });
    reloaded.hydrate(saved);

    expect(reloaded.since(0).map(entry => entry.record.text)).toEqual(['one']);
  });

  it('survives a missing or malformed save', () => {
    const journal = new MobileChatJournal({ now: () => 0 });
    journal.hydrate(undefined);
    journal.hydrate({} as unknown);
    journal.hydrate({ nextSeq: 'x', entries: 'nope' } as unknown);

    expect(journal.latestSeq()).toBe(0);
    expect(journal.append(record('one', 0)).seq).toBe(1);
  });
});

describe('MobileChatJournal pruning', () => {
  it('drops entries older than the ttl but keeps delivered ones inside it', () => {
    let clock = 0;
    const journal = new MobileChatJournal({ now: () => clock });
    journal.append(record('old', 0));
    clock = 23 * HOUR;
    journal.append(record('fresh', clock));

    clock = 24 * HOUR + 1;
    // Pruning runs on append; anything at all forces the sweep.
    journal.append(record('newer', clock));

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['fresh', 'newer']);
  });

  it('prunes on load, so a hub that was off for a day starts empty', () => {
    const saved: ChatJournalState = {
      nextSeq: 3,
      entries: [
        { seq: 1, record: record('ancient', 0) },
        { seq: 2, record: record('recent', 23 * HOUR) },
      ],
    };
    const journal = new MobileChatJournal({ now: () => 24 * HOUR + 1 });
    journal.hydrate(saved);

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['recent']);
  });

  it('drops the oldest past the hard safety cap', () => {
    const journal = new MobileChatJournal({ now: () => 0, maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) journal.append(record(`m${index}`, index));

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['m2', 'm3', 'm4']);
  });
});
