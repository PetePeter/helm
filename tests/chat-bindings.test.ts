/**
 * chatBindings — generic per-provider session bindings with legacy Telegram
 * state discarded during migration.
 *
 * Two regressions are guarded here, both of which have bitten this project
 * before: a persisted field that never reaches `serializeSession` (invariant 6),
 * and a loader that silently drops a key it does not recognise — exactly how
 * fleet lost `machineId`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessions, saveSessions } from '../src/session/session-persistence';
import type { SessionInfo } from '../src/types/session';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-chat-bindings-'));
  file = join(dir, 'sessions.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 's1', name: 'work', cliType: 'claudecode', processId: 1234, ...overrides };
}

function roundTrip(sessions: SessionInfo[]): SessionInfo[] {
  saveSessions(sessions, file);
  return loadSessions(file);
}

describe('chatBindings persistence', () => {
  it('loads a legacy Telegram binding and topicId but drops both on the next save', () => {
    const legacy = `sessions:\n  - id: s1\n    name: work\n    cliType: claudecode\n    processId: 1234\n    topicId: 77\n    chatBindings:\n      telegram: 77\n      lan: room-7\n`;
    writeFileSync(file, legacy, 'utf8');

    const [restored] = loadSessions(file);

    expect(restored.name).toBe('work');
    expect(restored.topicId).toBeUndefined();
    expect(restored.chatBindings).toEqual({ lan: 'room-7' });

    saveSessions([restored], file);
    const persisted = readFileSync(file, 'utf8');
    expect(persisted).not.toContain('telegram');
    expect(persisted).not.toContain('topicId');
    expect(persisted).toContain('lan: room-7');
  });

  it('loads a topicId-only legacy record without retaining the Telegram field', () => {
    const legacy = `sessions:\n  - id: s1\n    name: work\n    cliType: claudecode\n    processId: 1234\n    topicId: 77\n`;
    writeFileSync(file, legacy, 'utf8');

    const [restored] = loadSessions(file);

    expect(restored.name).toBe('work');
    expect(restored.topicId).toBeUndefined();
    expect(restored.chatBindings).toBeUndefined();
  });

  it('preserves bindings for other providers across a save/load round-trip', () => {
    const [restored] = roundTrip([session({ chatBindings: { lan: 'room-7' } })]);

    expect(restored.chatBindings).toEqual({ lan: 'room-7' });
    expect(restored.topicId).toBeUndefined();
  });

  it('writes no chatBindings key at all for a session with no chat surfaces', () => {
    const [restored] = roundTrip([session()]);

    expect(restored.chatBindings).toBeUndefined();
    expect(restored.topicId).toBeUndefined();
  });
});
