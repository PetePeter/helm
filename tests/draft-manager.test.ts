/**
 * DraftManager over its real file store in a temp dir: the pad both the
 * user and the session's LLM write, and the rules that stop either one
 * silently overwriting the other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DraftManager } = await import('../src/session/draft-manager.js');
const { createDraftStore, migrateLegacyDraftStore } = await import('../src/session/draft-persistence.js');
const { DRAFT_MAX_BYTES } = await import('../src/types/draft.js');

describe('DraftManager', () => {
  let dir: string;
  let clock: number;
  const open = () => new DraftManager(createDraftStore(dir), () => clock);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-draft-'));
    clock = 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts every session on an empty pad at revision 0 without writing a file', () => {
    expect(open().get('s1')).toEqual({ sessionId: 's1', text: '', revision: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('round-trips a write and survives a restart', () => {
    const result = open().set('s1', 'todo: ship', 'user', 0);
    expect(result).toEqual({ ok: true, draft: { sessionId: 's1', text: 'todo: ship', revision: 1, updatedAt: 1000, updatedBy: 'user' } });
    expect(open().get('s1')).toEqual(result.draft);
  });

  it('never returns one session\'s pad for another session', () => {
    const manager = open();
    manager.set('s1', 'mine', 'user', 0);
    expect(manager.get('s2').text).toBe('');
    expect(open().get('s2').revision).toBe(0);
  });

  it('refuses a write based on a stale revision and hands back the current pad', () => {
    const manager = open();
    manager.set('s1', 'user typed this', 'user', 0);
    const stale = manager.set('s1', 'the AI overwrites', 'ai', 0);
    expect(stale).toMatchObject({ ok: false, reason: 'stale', draft: { text: 'user typed this', revision: 1 } });
    expect(manager.get('s1').text).toBe('user typed this');
    expect(manager.set('s1', 'user typed this\n+ AI note', 'ai', 1)).toMatchObject({ ok: true, draft: { revision: 2, updatedBy: 'ai' } });
  });

  it('refuses text over the size cap and keeps the old text', () => {
    const manager = open();
    manager.set('s1', 'keep', 'user', 0);
    const refused = manager.set('s1', 'x'.repeat(DRAFT_MAX_BYTES + 1), 'ai', 1);
    expect(refused).toMatchObject({ ok: false, reason: 'too_large', draft: { text: 'keep', revision: 1 } });
    expect(open().get('s1').text).toBe('keep');
    expect(manager.set('s1', 'x'.repeat(DRAFT_MAX_BYTES), 'ai', 1).ok).toBe(true);
  });

  it('measures the cap in stored bytes, not characters', () => {
    const refused = open().set('s1', '€'.repeat(DRAFT_MAX_BYTES / 2), 'user', 0);
    expect(refused).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('appends on a new line without needing a revision, and refuses to grow past the cap', () => {
    const manager = open();
    expect(manager.append('s1', 'first', 'ai').draft.text).toBe('first');
    expect(manager.append('s1', 'second', 'ai').draft).toMatchObject({ text: 'first\nsecond', revision: 2 });
    manager.set('s1', 'ends with newline\n', 'user', 2);
    expect(manager.append('s1', 'third', 'ai').draft.text).toBe('ends with newline\nthird');
    const refused = manager.append('s1', 'x'.repeat(DRAFT_MAX_BYTES), 'ai');
    expect(refused).toMatchObject({ ok: false, reason: 'too_large', draft: { text: 'ends with newline\nthird' } });
  });

  it('emits the new pad on every change and nothing on a refusal or a no-op', () => {
    const manager = open();
    const seen: unknown[] = [];
    manager.on('draft:changed', pad => seen.push(pad));
    manager.set('s1', 'a', 'ai', 0);
    manager.set('s1', 'a', 'ai', 1); // same text
    manager.set('s1', 'b', 'ai', 0); // stale
    manager.append('s1', '', 'ai');
    expect(seen).toEqual([{ sessionId: 's1', text: 'a', revision: 1, updatedAt: 1000, updatedBy: 'ai' }]);
    expect(manager.get('s1').revision).toBe(1);
  });

  it('keeps the revision climbing when the pad is emptied, so an old writer stays stale', () => {
    const manager = open();
    manager.set('s1', 'a', 'user', 0);
    manager.set('s1', '', 'user', 1);
    expect(open().get('s1')).toMatchObject({ text: '', revision: 2 });
    expect(manager.set('s1', 'late', 'ai', 0).ok).toBe(false);
  });

  it('copies a pad to the session that continues it, leaving the source its own', () => {
    const manager = open();
    manager.set('old', 'carry me', 'ai', 0);
    manager.copySession('old', 'new');
    manager.copySession('never-written', 'other');
    expect(open().get('new')).toMatchObject({ text: 'carry me', revision: 1, updatedBy: 'ai' });
    expect(manager.get('old').text).toBe('carry me');
    expect(readdirSync(dir).sort()).toEqual(['new.json', 'old.json']);
  });

  it('deletes the file when the session is cleared', () => {
    const manager = open();
    manager.set('s1', 'a', 'user', 0);
    manager.set('s2', 'b', 'user', 0);
    manager.clearSession('s1');
    expect(manager.get('s1')).toEqual({ sessionId: 's1', text: '', revision: 0 });
    expect(readdirSync(dir)).toEqual(['s2.json']);
  });

  it('prunes only pads whose session is neither live nor in the recycle bin', () => {
    const manager = open();
    for (const id of ['live', 'binned', 'orphan']) manager.set(id, id, 'user', 0);
    expect(open().pruneOrphans(new Set(['live', 'binned']))).toEqual(['orphan']);
    expect(readdirSync(dir).sort()).toEqual(['binned.json', 'live.json']);
  });

  it('still prunes orphans when the directory holds a file it did not write', () => {
    const manager = open();
    manager.set('live', 'a', 'user', 0);
    manager.set('orphan', 'b', 'user', 0);
    writeFileSync(join(dir, 'bad%.json'), '{}');
    expect(open().pruneOrphans(new Set(['live']))).toEqual(['orphan']);
    expect(readdirSync(dir).sort()).toEqual(['bad%.json', 'live.json']);
  });

  it('reads a damaged file as an empty pad instead of throwing', () => {
    writeFileSync(join(dir, 's1.json'), '{not json');
    writeFileSync(join(dir, 's2.json'), JSON.stringify({ text: 42, revision: 3 }));
    const manager = open();
    expect(manager.get('s1').revision).toBe(0);
    expect(manager.get('s2').text).toBe('');
  });

  it('cannot be steered outside its directory by a session id', () => {
    const manager = open();
    manager.set('../escape', 'x', 'ai', 0);
    manager.set('..', 'y', 'ai', 0);
    expect(existsSync(join(dir, '..', 'escape.json'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['..%2Fescape.json']);
    expect(open().get('../escape').text).toBe('x');
  });
});

describe('migrateLegacyDraftStore', () => {
  let configDir: string;
  beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'helm-draft-migrate-')); });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it('carries scratchpads over to drafts and deletes the retired memo/template files', () => {
    mkdirSync(join(configDir, 'scratchpads'));
    writeFileSync(join(configDir, 'scratchpads', 's1.json'), '{"text":"hi","revision":1}');
    writeFileSync(join(configDir, 'drafts.yaml'), 'drafts: []');
    writeFileSync(join(configDir, 'prompt-templates.yaml'), 'items: []');

    migrateLegacyDraftStore(configDir);

    expect(createDraftStore(join(configDir, 'drafts')).load('s1')?.text).toBe('hi');
    expect(readdirSync(configDir).sort()).toEqual(['drafts']);
  });

  it('never overwrites an existing drafts dir', () => {
    mkdirSync(join(configDir, 'scratchpads'));
    mkdirSync(join(configDir, 'drafts'));
    writeFileSync(join(configDir, 'drafts', 's1.json'), '{"text":"new","revision":2}');

    migrateLegacyDraftStore(configDir);

    expect(createDraftStore(join(configDir, 'drafts')).load('s1')?.text).toBe('new');
    expect(existsSync(join(configDir, 'scratchpads'))).toBe(true);
  });
});
