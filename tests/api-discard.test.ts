import { describe, expect, it } from 'vitest';
import { DiscardTable, lookupKey, withForce } from '../src/session/api/api-discard.js';

describe('lookupKey', () => {
  it('takes a ranked memory search as the same search in any case, spacing or term order', () => {
    const key = lookupKey('memory_search', { query: 'vitest shared appdata' });
    expect(lookupKey('memory_search', { query: '  AppData   VITEST shared ' })).toBe(key);
    expect(lookupKey('memory_search', { query: 'vitest shared appdata', force: true })).toBe(key);
    expect(lookupKey('memory_search', { query: 'vitest shared' })).not.toBe(key);
  });

  it('takes a regular expression as written', () => {
    expect(lookupKey('memory_search', { query: 'Port \\d+', regex: true }))
      .not.toBe(lookupKey('memory_search', { query: '\\d+ port', regex: true }));
  });

  it('tells tools and paths apart, whatever order the arguments came in', () => {
    const key = lookupKey('Grep', { pattern: 'TODO', path: 'src' });
    expect(lookupKey('Grep', { path: 'src', pattern: 'TODO' })).toBe(key);
    expect(lookupKey('Grep', { pattern: 'TODO', path: 'tests' })).not.toBe(key);
    expect(lookupKey('Grep', { pattern: 'todo', path: 'src' })).not.toBe(key);
    // A space is part of a regular expression and of a glob.
    expect(lookupKey('Grep', { pattern: ' TODO', path: 'src' })).not.toBe(key);
    expect(lookupKey('Glob', { pattern: '*.ts ' })).not.toBe(lookupKey('Glob', { pattern: '*.ts' }));
    expect(lookupKey('Glob', { pattern: 'TODO', path: 'src' })).not.toBe(key);
  });
});

describe('DiscardTable', () => {
  /** A clock the test moves: local times of one day. */
  function setup() {
    let now = new Date(2026, 9, 14, 14, 2);
    const table = new DiscardTable(() => now);
    return { table, at: (hours: number, minutes: number) => { now = new Date(2026, 9, 14, hours, minutes); } };
  }

  it('lets a lookup that was never discarded run', () => {
    expect(setup().table.reject('k')).toBeUndefined();
  });

  it('refuses a repeat with the time it was discarded, as clock time and as age', () => {
    const { table, at } = setup();
    table.discard('k');
    at(14, 10);

    expect(table.reject('k')).toBe([
      'Not run: you discarded this lookup.',
      'First run and discarded: 14:02 (8 min ago)',
      'Now: 14:10. If things may have changed since, call again with "force": true.',
    ].join('\n'));
  });

  it('lists every earlier repeat with its own age', () => {
    const { table, at } = setup();
    table.discard('k');
    at(14, 10);
    table.reject('k');
    at(14, 31);
    table.reject('k');
    at(15, 40);

    expect(table.reject('k')).toBe([
      'Not run: you discarded this lookup.',
      'First run and discarded: 14:02 (1 h 38 min ago)',
      'Asked again and rejected: 14:10 (1 h 30 min ago), 14:31 (1 h 9 min ago)',
      'Now: 15:40. If things may have changed since, call again with "force": true.',
    ].join('\n'));
  });

  it('shows the newest repeats of a model that keeps asking, and counts the rest', () => {
    const { table, at } = setup();
    table.discard('k');
    for (let minute = 3; minute <= 9; minute++) { at(14, minute); table.reject('k'); }
    at(14, 10);

    expect(table.reject('k')).toContain(
      'Asked again and rejected: 2 earlier, then 14:05 (5 min ago), 14:06 (4 min ago), 14:07 (3 min ago), 14:08 (2 min ago), 14:09 (1 min ago)',
    );
    at(14, 11);
    expect(table.reject('k')).toContain('Asked again and rejected: 3 earlier, then 14:06 (5 min ago),');
  });

  it('keeps the first discard time when the same lookup is discarded again', () => {
    const { table, at } = setup();
    table.discard('k');
    at(14, 30);
    table.discard('k');

    expect(table.reject('k')).toContain('First run and discarded: 14:02 (28 min ago)');
  });

  it('forgets a lookup once it is released, and everything once cleared', () => {
    const { table } = setup();
    table.discard('a');
    table.discard('b');
    table.discard('c');

    table.release('a');
    expect(table.reject('a')).toBeUndefined();
    expect(table.reject('b')).toBeDefined();

    table.clear();
    expect(table.reject('c')).toBeUndefined();
  });
});

describe('withForce', () => {
  it('adds force to a lookup tool and leaves its other arguments and every other tool alone', () => {
    const read = { name: 'Read', description: 'd', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
    const write = { name: 'Write', description: 'd', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } };

    expect(withForce(read).parameters).toEqual({
      type: 'object',
      properties: { file_path: { type: 'string' }, force: { type: 'boolean', description: expect.any(String) } },
      required: ['file_path'],
    });
    expect(withForce({ name: 'memory_search', description: '', parameters: {} }).parameters).toMatchObject({ properties: { force: { type: 'boolean' } } });
    expect(withForce(write)).toBe(write);
  });
});
