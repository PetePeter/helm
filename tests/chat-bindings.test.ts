/**
 * chatBindings — the generic per-provider session binding that replaced the
 * Telegram-only `topicId` on disk.
 *
 * Two regressions are guarded here, both of which have bitten this project
 * before: a persisted field that never reaches `serializeSession` (invariant 6),
 * and a loader that silently drops a key it does not recognise — exactly how
 * fleet lost `machineId`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEGRAM_CHAT_PROVIDER } from '../src/session/chat/chat-bindings';
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
  it('carries a Telegram topic across a save/load round-trip', () => {
    const [restored] = roundTrip([session({ topicId: 42 })]);

    expect(restored.chatBindings).toEqual({ [TELEGRAM_CHAT_PROVIDER]: 42 });
    expect(restored.topicId).toBe(42);
  });

  it('preserves a binding for a provider this version has never heard of', () => {
    const [restored] = roundTrip([
      session({ topicId: 42, chatBindings: { [TELEGRAM_CHAT_PROVIDER]: 42, lan: 'room-7' } }),
    ]);

    expect(restored.chatBindings).toEqual({ [TELEGRAM_CHAT_PROVIDER]: 42, lan: 'room-7' });
  });

  it('migrates a legacy topicId-only record without losing the topic', () => {
    // A sessions.yaml written before chatBindings existed.
    const legacy = `sessions:\n  - id: s1\n    name: work\n    cliType: claudecode\n    processId: 1234\n    topicId: 77\n`;
    writeFileSync(file, legacy, 'utf8');

    const [restored] = loadSessions(file);

    expect(restored.topicId).toBe(77);
    expect(restored.chatBindings).toEqual({ [TELEGRAM_CHAT_PROVIDER]: 77 });
  });

  it('clears the Telegram binding when the topic is gone, rather than resurrecting it', () => {
    const [restored] = roundTrip([session({ chatBindings: { [TELEGRAM_CHAT_PROVIDER]: 42, lan: 'room-7' } })]);

    expect(restored.topicId).toBeUndefined();
    expect(restored.chatBindings).toEqual({ lan: 'room-7' });
  });

  it('writes no chatBindings key at all for a session with no chat surfaces', () => {
    const [restored] = roundTrip([session()]);

    expect(restored.chatBindings).toBeUndefined();
    expect(restored.topicId).toBeUndefined();
  });
});
