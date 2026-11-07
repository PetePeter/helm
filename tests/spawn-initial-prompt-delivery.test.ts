import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { promptSubmitSignal } from '../src/session/prompt-submit-signal.js';

class RedrawingPtyProcess implements PtyProcess {
  pid = 4321;
  writes: string[] = [];
  private onDataCallback: ((data: string) => void) | undefined;
  private taskPromptWritten = false;
  private redrawsScheduled = false;

  constructor(private readonly taskPrompt: string) {}

  onData(callback: (data: string) => void): void { this.onDataCallback = callback; }
  onExit(_callback: (exitCode: { exitCode: number; signal?: number }) => void): void {}
  resize(): void {}
  kill(): void {}

  write(data: string): void {
    this.writes.push(data);
    if (data.includes(this.taskPrompt)) this.taskPromptWritten = true;
    if (data === '\r' && this.taskPromptWritten && !this.redrawsScheduled) {
      this.redrawsScheduled = true;
      setTimeout(() => this.onDataCallback?.('Codex composer redraw one\n'), 500);
      setTimeout(() => this.onDataCallback?.('Codex composer redraw two\n'), 800);
    }
  }
}

class InMemorySessionManager {
  private readonly sessions = new Map<string, any>();

  addSession(session: any): void {
    this.sessions.set(session.id, { ...session, activityLevel: 'idle' });
  }
  hasSession(id: string): boolean { return this.sessions.has(id); }
  getSession(id: string): any { return this.sessions.get(id); }
  updateSession(id: string, session: any): void { this.sessions.set(id, session); }
}

describe('spawn-time initial prompt delivery', () => {
  afterEach(() => {
    promptSubmitSignal.forget('spawn-initial-codex');
    vi.useRealTimers();
  });

  it('waits for a submit hook and retries Enter when fresh Codex startup redraws without submitting', async () => {
    vi.useFakeTimers();
    const sessionId = 'spawn-initial-codex';
    const taskPrompt = 'first task prompt';
    const pty = new RedrawingPtyProcess(taskPrompt);
    const ptyFactory: PtyFactory = { spawn: () => pty };
    const ptyManager = new PtyManager(ptyFactory);
    const sessionManager = new InMemorySessionManager();
    const config = {
      name: 'Codex',
      displayName: 'Codex',
      spawnCommand: 'codex',
      provider: 'codex',
      initialPrompt: [{ label: 'Helm init', sequence: 'Call session_info{Enter}' }],
      initialPromptDelay: 0,
      submitSuffix: '\r',
    };
    const configLoader = {
      resolveCliType: () => ({ id: 'codex', config }),
      getCliTypeEntry: () => config,
    };
    promptSubmitSignal.forget(sessionId);

    spawnConfiguredSession({
      ptyManager,
      sessionManager: sessionManager as any,
      configLoader: configLoader as any,
      sessionId,
      cliType: 'codex',
      contextText: taskPrompt,
      fallbackCompleteDelayMs: 0,
    });

    await vi.runAllTimersAsync();

    expect(pty.writes.filter(write => write.includes(taskPrompt))).toHaveLength(1);
    // The bootstrap prompt and task each receive their original Enter, then
    // the verifier sends one submit-only Enter after no hook arrives.
    expect(pty.writes.filter(write => write === '\r')).toHaveLength(3);
  });
});
