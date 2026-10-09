import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { BUILTIN_SHELL_CLI_TYPE } from '../src/types/session.js';
import { loadSessions, saveSessions } from '../src/session/session-persistence.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('session persistence for built-in shells', () => {
  it('does not save or restore a built-in shell through the real sessions file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-shell-sessions-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');

    saveSessions([
      { id: 'claude-1', name: 'Claude', cliType: 'claude-code', processId: 123 },
      {
        id: 'pty-shell-1', name: 'Shell', cliType: BUILTIN_SHELL_CLI_TYPE, processId: 0,
        cliSessionName: 'shell-resume-id', workingDir: 'X:\\coding\\project',
      },
    ], file);

    expect(loadSessions(file).map(({ id, cliType }) => ({ id, cliType }))).toEqual([
      { id: 'claude-1', cliType: 'claude-code' },
    ]);
  });

  it('does not restore a shell that was saved by an older version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-legacy-shell-sessions-'));
    directories.push(directory);
    const file = join(directory, 'sessions.yaml');
    writeFileSync(file, YAML.stringify({
      sessions: [{
        id: 'pty-shell-old', name: 'Shell', cliType: BUILTIN_SHELL_CLI_TYPE, processId: 0,
        cliSessionName: 'old-shell-resume-id', workingDir: 'X:\\coding\\project',
      }],
    }));

    expect(loadSessions(file)).toEqual([]);
  });
});
