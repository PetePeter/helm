import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { loadSessions, saveSessions } from '../src/session/session-persistence.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('session context usage persistence', () => {
  it('round-trips the latest known token and optional window snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-session-context-usage-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');

    saveSessions([{
      id: 's1', name: 'worker', cliType: 'claude-code', processId: 1,
      contextUsage: { tokens: 18_400, window: 200_000, level: 'warn', measuredAtIso: '2026-10-15T00:00:00.000Z' },
    }], file);

    expect(loadSessions(file)[0]?.contextUsage).toEqual({
      tokens: 18_400,
      window: 200_000,
      level: 'warn',
      measuredAtIso: '2026-10-15T00:00:00.000Z',
    });
  });

  it('drops malformed snapshots from older or hand-edited session files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-session-invalid-context-usage-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');
    writeFileSync(file, YAML.stringify({ sessions: [{
      id: 's1', name: 'worker', cliType: 'claude-code', processId: 1,
      contextUsage: { tokens: 0, window: -5 },
    }] }));

    expect(loadSessions(file)[0]?.contextUsage).toBeUndefined();
  });

  it('round-trips the token history and drops malformed samples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-session-context-history-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');
    writeFileSync(file, YAML.stringify({ sessions: [{
      id: 's1', name: 'worker', cliType: 'claude-code', processId: 1,
      contextHistory: [{ at: 1, tokens: 100 }, { at: 'x', tokens: 5 }, { at: 3, tokens: 300 }],
    }] }));
    const loaded = loadSessions(file);
    expect(loaded[0]?.contextHistory).toEqual([{ at: 1, tokens: 100 }, { at: 3, tokens: 300 }]);

    saveSessions(loaded, file);
    expect(loadSessions(file)[0]?.contextHistory).toEqual([{ at: 1, tokens: 100 }, { at: 3, tokens: 300 }]);
  });
});
