import { describe, expect, it, vi } from 'vitest';
import { selectSessionFromDock } from '../renderer/dock-session-navigation.js';

describe('dock session navigation', () => {
  it('keeps the active Chat pane while changing sessions', () => {
    const activateSession = vi.fn(() => ({ kind: 'local-terminal' as const, sessionId: 'two' }));
    const syncSidebarToSession = vi.fn();
    const navigateToSession = vi.fn();

    const result = selectSessionFromDock('two', {
      isChatPaneActive: () => true,
      activateSession,
      syncSidebarToSession,
      navigateToSession,
    });

    expect(result).toEqual({ kind: 'local-terminal', sessionId: 'two' });
    expect(activateSession).toHaveBeenCalledWith('two');
    expect(syncSidebarToSession).toHaveBeenCalledWith('two');
    expect(navigateToSession).not.toHaveBeenCalled();
  });

  it('uses normal navigation when Chat is not active', () => {
    const activateSession = vi.fn();
    const syncSidebarToSession = vi.fn();
    const navigateToSession = vi.fn(() => Promise.resolve({ kind: 'local-terminal' as const, sessionId: 'two' }));

    const result = selectSessionFromDock('two', {
      isChatPaneActive: () => false,
      activateSession,
      syncSidebarToSession,
      navigateToSession,
    });

    expect(result).toBeInstanceOf(Promise);
    expect(navigateToSession).toHaveBeenCalledWith('two');
    expect(activateSession).not.toHaveBeenCalled();
    expect(syncSidebarToSession).not.toHaveBeenCalled();
  });
});
