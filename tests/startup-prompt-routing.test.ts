import { describe, expect, it, vi } from 'vitest';
import { routeStartupPrompt } from '../src/session/startup-prompt-routing.js';
import type { StartupPromptBlockedEvent } from '../src/session/startup-prompt-watcher.js';

const event: StartupPromptBlockedEvent = {
  sessionId: 'blocked-session',
  cliType: 'claude-code',
  creatorSessionId: 'creator-session',
  excerpt: 'Do you trust the files in this folder?',
  repeat: false,
};

function dependencies(creatorExists: boolean) {
  return {
    getSession: vi.fn((id: string) => id === 'creator-session' && creatorExists ? { id } : null),
    sendSystemReminder: vi.fn(async () => undefined),
    notify: vi.fn(),
  };
}

describe('routeStartupPrompt', () => {
  it('delivers a single-line reminder to a live creator session', async () => {
    const deps = dependencies(true);
    await routeStartupPrompt(event, deps);
    expect(deps.sendSystemReminder).toHaveBeenCalledWith(
      'creator-session', expect.stringContaining('blocked-session'),
    );
    expect(deps.sendSystemReminder.mock.calls[0][1]).not.toMatch(/[\r\n]/);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('alerts on the blocked session when there is no live local creator', async () => {
    const deps = dependencies(false);
    await routeStartupPrompt(event, deps);
    expect(deps.notify).toHaveBeenCalledWith(
      'blocked-session', 'Startup prompt blocked', expect.stringContaining(event.excerpt),
    );
    expect(deps.sendSystemReminder).not.toHaveBeenCalled();
  });

  it('falls back to the blocked session alert if creator delivery fails', async () => {
    const deps = dependencies(true);
    deps.sendSystemReminder.mockRejectedValue(new Error('creator closed'));
    await routeStartupPrompt(event, deps);
    expect(deps.notify).toHaveBeenCalledWith('blocked-session', 'Startup prompt blocked', expect.any(String));
  });
});
