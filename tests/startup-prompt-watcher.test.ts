import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import type { CliTypeConfig } from '../src/config/loader.js';
import { serializeSession } from '../src/session/session-persistence.js';
import { StartupPromptWatcher } from '../src/session/startup-prompt-watcher.js';
import { ansiEscapeSplitInsideText, ansiSplit, knownStartupPromptText } from './fixtures/startup-prompts.js';

const shipped = Object.values(YAML.parse(readFileSync(new URL('../src/config/cli-types.yaml', import.meta.url), 'utf8')) as Record<string, CliTypeConfig>);
const rules = {
  claude: shipped.find(entry => entry.displayName === 'Claude Code')?.startupPrompts ?? [],
  codex: shipped.find(entry => entry.displayName === 'Codex')?.startupPrompts ?? [],
  copilot: shipped.find(entry => entry.displayName === 'GitHub Copilot CLI')?.startupPrompts ?? [],
};

function makeWatcher() {
  const updateSession = vi.fn();
  const watcher = new StartupPromptWatcher({
    getPrompts: (cliType) => rules[cliType as keyof typeof rules] ?? [],
    updateSession,
    startupWindowMs: 60_000,
    reminderDelayMs: 30_000,
    tailLimit: 320,
  });
  return { watcher, updateSession };
}

describe('StartupPromptWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it.each([
    ['claude', knownStartupPromptText.claudeCode],
    ['codex', knownStartupPromptText.codexTrust],
    ['codex', knownStartupPromptText.codexAllow],
    ['copilot', knownStartupPromptText.copilotConfirm],
    ['copilot', knownStartupPromptText.copilotTrust],
  ])('detects split ANSI-wrapped known text for %s', (cliType, prompt) => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 's1', cliType, creatorSessionId: 'creator-1' });
    const [first, second] = ansiSplit(prompt);
    watcher.processOutput('s1', first);
    watcher.processOutput('s1', second);

    expect(updateSession).toHaveBeenCalledWith('s1', { blockedOn: 'startup-prompt' });
    expect(blocked).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', cliType, creatorSessionId: 'creator-1', repeat: false,
      excerpt: prompt,
    }));
    watcher.dispose();
  });

  it('matches when an ANSI sequence is split inside prompt text', () => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'split-escape', cliType: 'claude' });
    const [first, second] = ansiEscapeSplitInsideText(knownStartupPromptText.claudeCode);
    watcher.processOutput('split-escape', first);
    watcher.processOutput('split-escape', second);

    expect(updateSession).toHaveBeenCalledWith('split-escape', { blockedOn: 'startup-prompt' });
    expect(blocked).toHaveBeenCalledWith(expect.objectContaining({
      excerpt: knownStartupPromptText.claudeCode,
      repeat: false,
    }));
    watcher.dispose();
  });

  it('sends one reminder at 30 seconds only while the same prompt remains', () => {
    const { watcher } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 's1', cliType: 'claude' });
    for (const chunk of ansiSplit(knownStartupPromptText.claudeCode)) watcher.processOutput('s1', chunk);
    vi.advanceTimersByTime(30_000);
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(blocked.mock.calls[1][0]).toMatchObject({ repeat: true });
    vi.advanceTimersByTime(30_000);
    expect(blocked).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('clears the runtime block when prompt text rolls out of the tail', () => {
    const { watcher, updateSession } = makeWatcher();
    watcher.watch({ sessionId: 's1', cliType: 'claude' });
    for (const chunk of ansiSplit(knownStartupPromptText.claudeCode)) watcher.processOutput('s1', chunk);
    watcher.processOutput('s1', 'x'.repeat(400));
    expect(updateSession).toHaveBeenLastCalledWith('s1', { blockedOn: undefined });
    vi.advanceTimersByTime(30_000);
    watcher.dispose();
  });

  it('cancels the reminder when a short replacement screen follows the prompt', () => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'replaced', cliType: 'claude' });
    watcher.processOutput('replaced', knownStartupPromptText.claudeCode);
    watcher.processOutput('replaced', '\r\nStarting a new workspace');

    expect(updateSession).toHaveBeenLastCalledWith('replaced', { blockedOn: undefined });
    vi.advanceTimersByTime(30_000);
    expect(blocked).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it.each(['\x1b[2J', '\x1b[3J', '\x1bc'])('drops prior screen text after terminal reset %s', (reset) => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'reset', cliType: 'claude' });
    watcher.processOutput('reset', knownStartupPromptText.claudeCode);
    watcher.processOutput('reset', `${reset}Starting a new workspace`);

    expect(updateSession).toHaveBeenLastCalledWith('reset', { blockedOn: undefined });
    vi.advanceTimersByTime(30_000);
    expect(blocked).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('clears the block and reminder timer when readiness arrives after detection', () => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'ready-after-prompt', cliType: 'claude' });
    watcher.processOutput('ready-after-prompt', knownStartupPromptText.claudeCode);
    watcher.markReady('ready-after-prompt');
    expect(updateSession).toHaveBeenLastCalledWith('ready-after-prompt', { blockedOn: undefined });
    vi.advanceTimersByTime(30_000);
    expect(blocked).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('stops watching after readiness or the startup window', () => {
    const { watcher, updateSession } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'ready', cliType: 'claude' });
    watcher.markReady('ready');
    watcher.processOutput('ready', knownStartupPromptText.claudeCode);
    watcher.watch({ sessionId: 'expired', cliType: 'claude' });
    vi.advanceTimersByTime(60_000);
    watcher.processOutput('expired', knownStartupPromptText.claudeCode);
    expect(blocked).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('leaves unknown CLI types inert and removes session timers', () => {
    const { watcher } = makeWatcher();
    const blocked = vi.fn();
    watcher.on('blocked', blocked);
    watcher.watch({ sessionId: 'unknown', cliType: 'custom-cli' });
    watcher.processOutput('unknown', knownStartupPromptText.claudeCode);
    watcher.watch({ sessionId: 'removed', cliType: 'claude' });
    watcher.removeSession('removed');
    vi.runAllTimers();
    expect(blocked).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('keeps blockedOn out of serialized session data', () => {
    const serialized = serializeSession({
      id: 's1', name: 'Claude', cliType: 'claude', processId: 1, blockedOn: 'startup-prompt',
    });
    expect(serialized).not.toHaveProperty('blockedOn');
  });
});
