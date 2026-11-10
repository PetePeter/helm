import type { SessionInfo } from '../types/session.js';
import type { StartupPromptBlockedEvent } from './startup-prompt-watcher.js';
import { logger } from '../utils/logger.js';

export interface StartupPromptRoutingDependencies {
  getSession: (sessionId: string) => SessionInfo | null;
  sendSystemReminder: (sessionId: string, text: string) => Promise<void>;
  notify: (sessionId: string, title: string, content: string) => void;
}

/** Route the detected prompt to its live local creator, or alert on the blocked session. */
export async function routeStartupPrompt(
  event: StartupPromptBlockedEvent,
  dependencies: StartupPromptRoutingDependencies,
): Promise<void> {
  const message = `Session ${event.sessionId} (${event.cliType}) is blocked by a startup prompt: ${event.excerpt}`;
  const creatorSessionId = event.creatorSessionId;
  if (creatorSessionId && dependencies.getSession(creatorSessionId)) {
    try {
      await dependencies.sendSystemReminder(creatorSessionId, message);
      return;
    } catch (error) {
      logger.warn(`[StartupPromptRouting] Creator delivery failed for ${creatorSessionId}: ${String(error)}`);
    }
  }
  dependencies.notify(event.sessionId, 'Startup prompt blocked', message);
}
