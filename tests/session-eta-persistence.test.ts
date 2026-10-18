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

describe('session ETA persistence', () => {
  it('round-trips a validated ETA through the real session file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-session-eta-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');
    const eta = { at: 1_800_000_000_000, setAt: 1_799_999_000_000, note: 'ship the test' };

    saveSessions([{ id: 's1', name: 'worker', cliType: 'claude-code', processId: 1, eta }], file);

    expect(loadSessions(file)[0].eta).toEqual(eta);
  });

  it('drops a malformed ETA without discarding its session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-invalid-session-eta-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');
    writeFileSync(file, YAML.stringify({ sessions: [{
      id: 's1', name: 'worker', cliType: 'claude-code', processId: 1,
      eta: { at: 'tomorrow', setAt: 5, note: 42 },
    }] }));

    const [restored] = loadSessions(file);
    expect(restored.id).toBe('s1');
    expect(restored).not.toHaveProperty('eta');
  });
});
