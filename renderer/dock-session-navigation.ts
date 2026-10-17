import type { ActivationResult } from './stores/navigation.js';

export interface DockSessionNavigation {
  isChatPaneActive: () => boolean;
  activateSession: (sessionId: string) => ActivationResult;
  syncSidebarToSession: (sessionId: string) => void;
  navigateToSession: (sessionId: string) => ActivationResult | Promise<ActivationResult>;
}

/** Preserve Chat as the user's current workspace when selecting another session. */
export function selectSessionFromDock(
  sessionId: string,
  navigation: DockSessionNavigation,
): ActivationResult | Promise<ActivationResult> {
  if (!navigation.isChatPaneActive()) return navigation.navigateToSession(sessionId);

  const result = navigation.activateSession(sessionId);
  if (result.kind === 'local-terminal' || result.kind === 'snapped-out') {
    navigation.syncSidebarToSession(sessionId);
  }
  return result;
}
