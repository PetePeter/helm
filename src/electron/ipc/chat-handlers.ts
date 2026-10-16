import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { ChatJournalEntry } from '../../mobile/mobile-chat-journal.js';
import type { ChatOutboundMessage } from '../../session/chat/chat-bridge.js';
import { logger } from '../../utils/logger.js';

interface DesktopChatSendInput {
  sessionId: string;
  text: string;
  filePath?: string;
}

export interface ChatHandlerDeps {
  history: (sessionId: string) => ChatJournalEntry[];
  deliver: (input: DesktopChatSendInput) => Promise<void>;
  fanOut: (message: ChatOutboundMessage) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function setupChatHandlers(deps: ChatHandlerDeps): void {
  ipcMain.handle('chat:history', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' && sessionId.trim() ? deps.history(sessionId) : []);

  ipcMain.handle('chat:send', async (_event, value: unknown) => {
    if (!isRecord(value)
      || typeof value.sessionId !== 'string' || !value.sessionId.trim()
      || typeof value.text !== 'string'
      || (value.filePath !== undefined && typeof value.filePath !== 'string')) {
      return { ok: false, error: 'Invalid chat message' };
    }

    const input: DesktopChatSendInput = {
      sessionId: value.sessionId,
      text: value.text,
      ...(typeof value.filePath === 'string' && value.filePath ? { filePath: value.filePath } : {}),
    };
    if (!input.text.trim() && !input.filePath) return { ok: false, error: 'Nothing to send' };

    try {
      await deps.deliver(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const message: ChatOutboundMessage = {
      sessionId: input.sessionId,
      text: input.text,
      source: 'desktop',
      originId: `desktop:${randomUUID()}`,
      ...(input.filePath ? { filePath: input.filePath } : {}),
    };
    try {
      await deps.fanOut(message);
    } catch (error) {
      // A surface outage must not turn a successfully delivered prompt into a
      // failed desktop send that the user may retry and deliver twice.
      logger.warn(`[Chat IPC] Could not mirror desktop chat turn: ${error}`);
    }
    return { ok: true };
  });
}
