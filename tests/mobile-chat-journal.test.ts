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
    const journal = new MobileChatJournal();

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
      persist: (state) => { saved = state; },
    });
    journal.append(record('one', 0));
    journal.append(record('two', 1));

    const reloaded = new MobileChatJournal();
    reloaded.hydrate(saved);

    expect(reloaded.latestSeq()).toBe(2);
    expect(reloaded.append(record('three', 2)).seq).toBe(3);
  });

  it('carries the entries themselves across a reload', () => {
    let saved: ChatJournalState | undefined;
    const journal = new MobileChatJournal({ persist: (state) => { saved = state; } });
    journal.append(record('one', 0));

    const reloaded = new MobileChatJournal();
    reloaded.hydrate(saved);

    expect(reloaded.since(0).map(entry => entry.record.text)).toEqual(['one']);
  });

  it('survives a missing or malformed save', () => {
    const journal = new MobileChatJournal();
    journal.hydrate(undefined);
    journal.hydrate({} as unknown);
    journal.hydrate({ nextSeq: 'x', entries: 'nope' } as unknown);

    expect(journal.latestSeq()).toBe(0);
    expect(journal.append(record('one', 0)).seq).toBe(1);
  });
});

describe('MobileChatJournal retention', () => {
  // Retention is the SESSION'S lifetime, not an age: a phone that comes back a
  // week later still gets the conversation, because the session (or its recycle
  // bin entry) was alive the whole time.
  it('keeps entries of any age — there is no ttl', () => {
    const journal = new MobileChatJournal();
    journal.append(record('a week old', 0));
    journal.append(record('now', 8 * 24 * HOUR));

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['a week old', 'now']);
  });

  it('keeps old entries across a reload — time offline does not age them out', () => {
    const saved: ChatJournalState = {
      nextSeq: 2,
      entries: [
        { seq: 1, record: record('ancient', 0) },
        { seq: 2, record: record('recent', 23 * HOUR) },
      ],
    };
    const journal = new MobileChatJournal();
    journal.hydrate(saved);

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['ancient', 'recent']);
  });

  it('prunes exactly one session on purge, keeping every other session intact', () => {
    const journal = new MobileChatJournal();
    journal.append(record('theirs', 0));
    journal.append({ ...record('ours', 1), sessionId: 's2' });
    journal.append(record('theirs again', 2));

    const pruned = journal.pruneSession('s1');

    expect(pruned).toBe(2);
    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['ours']);
  });

  it('persists the prune, so a purge survives a restart', () => {
    let saved: ChatJournalState | undefined;
    const journal = new MobileChatJournal({ persist: (state) => { saved = state; } });
    journal.append(record('gone', 0));

    journal.pruneSession('s1');

    const reloaded = new MobileChatJournal();
    reloaded.hydrate(saved);
    expect(reloaded.since(0)).toEqual([]);
  });

  it('drops the oldest past the hard safety cap', () => {
    const journal = new MobileChatJournal({ maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) journal.append(record(`m${index}`, index));

    expect(journal.since(0).map(entry => entry.record.text)).toEqual(['m2', 'm3', 'm4']);
  });
});
