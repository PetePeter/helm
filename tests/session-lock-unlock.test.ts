/**
 * Unlocking a session — both routes were broken.
 *
 * 1. MCP: `session_set_locked` validated its `locked` argument with
 *    requireBooleanResult, an assertion helper that THROWS on a falsy value
 *    and always returns true. `locked: false` therefore raised "locked is
 *    required" and unlocking was impossible; `locked: true` was the only
 *    accepted input. (The pre-existing tsc error on that line was this bug.)
 *
 * 2. UI: refreshSessions rebuilds each renderer Session from an explicit field
 *    list that omitted `locked`, so the card fell back to 🔓 on every refresh
 *    and its click always asked to LOCK — never to unlock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asBoolean } from '../src/mcp/tools/validation.js';
import { saveSessions, loadSessions } from '../src/session/session-persistence.js';
import type { SessionInfo } from '../src/types/session.js';

describe('asBoolean', () => {
  it('accepts false — the whole point, since false is what unlocks', () => {
    expect(asBoolean(false, 'locked is required')).toBe(false);
  });

  it('accepts true', () => {
    expect(asBoolean(true, 'locked is required')).toBe(true);
  });

  it('rejects a missing value', () => {
    expect(() => asBoolean(undefined, 'locked is required')).toThrow('locked is required');
  });

  it('rejects a non-boolean rather than coercing it', () => {
    expect(() => asBoolean('false', 'locked is required')).toThrow('locked is required');
    expect(() => asBoolean(0, 'locked is required')).toThrow('locked is required');
  });
});

/**
 * The third route, and the one that survived the first two fixes.
 *
 * The persisted snapshot omitted `locked` entirely when false, and the renderer
 * folds that snapshot into its cached session records with a spread merge. A
 * missing key cannot overwrite anything, so a stale `locked: true` outlived
 * every unlock and the card reverted to 🔒 on the next refresh.
 *
 * Absence must therefore never be the way "unlocked" is expressed.
 */
describe('session persistence — lock state', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sessionsFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'helm-lock-'));
    dirs.push(dir);
    return join(dir, 'sessions.yaml');
  }

  const base: SessionInfo = {
    id: 'session-1',
    name: 'copilot',
    cliType: 'copilot-cli',
    processId: 1001,
  };

  it('persists locked: false for an unlocked session rather than omitting it', () => {
    const file = sessionsFile();
    saveSessions([{ ...base, locked: false }], file);

    expect(loadSessions(file)[0].locked).toBe(false);
  });

  it('persists locked: true for a locked session', () => {
    const file = sessionsFile();
    saveSessions([{ ...base, locked: true }], file);

    expect(loadSessions(file)[0].locked).toBe(true);
  });

  it('reports a never-locked session as explicitly unlocked', () => {
    const file = sessionsFile();
    saveSessions([base], file);

    expect(loadSessions(file)[0].locked).toBe(false);
  });
});

describe('session persistence — hidden state', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sessionsFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'helm-hidden-'));
    dirs.push(dir);
    return join(dir, 'sessions.yaml');
  }

  const base: SessionInfo = {
    id: 'session-1',
    name: 'copilot',
    cliType: 'copilot-cli',
    processId: 1001,
  };

  it('persists hidden: true', () => {
    const file = sessionsFile();
    saveSessions([{ ...base, hidden: true }], file);

    expect(loadSessions(file)[0].hidden).toBe(true);
  });

  it('omits hidden when false', () => {
    const file = sessionsFile();
    saveSessions([{ ...base, hidden: false }], file);

    expect(readFileSync(file, 'utf8')).not.toContain('hidden:');
    expect(loadSessions(file)[0].hidden).toBeUndefined();
  });

  it('ignores malformed hidden values when loading', () => {
    const file = sessionsFile();
    writeFileSync(file, `sessions:\n  - id: session-1\n    name: copilot\n    cliType: copilot-cli\n    processId: 1001\n    hidden: "true"\n`);

    expect(loadSessions(file)[0].hidden).toBeUndefined();
  });
});
