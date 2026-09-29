/**
 * Voice IPC Handlers — desktop hold-to-talk to the Helm operator
 * (docs/voice-operator.md).
 *
 * `voice:transcribe` / `voice:speak` front the shared OpenWhispr/Piper
 * VoiceService; `voice:ask` hands the user's words to the operator. Replies come
 * back the other way on `voice:operatorReply` (see DesktopVoiceBridge).
 */
import { ipcMain } from 'electron';
import { logger } from '../../utils/logger.js';
import type { VoiceResult, VoiceService } from '../../voice/voice-service.js';
import type { ChatJournalEntry } from '../../mobile/mobile-chat-journal.js';

export interface VoiceHandlerDeps {
  voiceService: Pick<VoiceService, 'transcribe' | 'speak'>;
  /** Deliver the user's words (and optionally a local file) to the operator,
   *  or to the named chat-capable session (an API tool). */
  ask: (text: string, filePath?: string, sessionId?: string) => Promise<VoiceResult>;
  /** The operator's newest persisted reply, so the sidebar survives a restart. */
  lastReply: () => string | null;
  /** A chat session's whole journaled conversation (default: the operator's), for the desktop chat view. */
  history: (sessionId?: string) => ChatJournalEntry[];
}

export function setupVoiceHandlers(deps: VoiceHandlerDeps): void {
  ipcMain.handle('voice:transcribe', async (_event, audio: unknown, mimeType: unknown) => {
    if (!(audio instanceof Uint8Array) || typeof mimeType !== 'string') {
      return { ok: false, error: 'Invalid audio payload' };
    }
    return deps.voiceService.transcribe(audio, mimeType);
  });

  ipcMain.handle('voice:speak', async (_event, text: unknown) => {
    if (typeof text !== 'string') return { ok: false, error: 'Invalid text' };
    return deps.voiceService.speak(text);
  });

  ipcMain.handle('voice:lastOperatorReply', () => deps.lastReply());

  ipcMain.handle('voice:operatorHistory', (_event, sessionId?: unknown) =>
    deps.history(typeof sessionId === 'string' ? sessionId : undefined));

  ipcMain.handle('voice:ask', async (_event, text: unknown, filePath?: unknown, sessionId?: unknown) => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'Nothing to send' };
    if (filePath !== undefined && typeof filePath !== 'string') return { ok: false, error: 'Invalid attachment' };
    try {
      return await deps.ask(text.trim(), filePath || undefined, typeof sessionId === 'string' ? sessionId : undefined);
    } catch (error) {
      logger.error(`[IPC] voice:ask failed: ${error}`);
      return { ok: false, error: String(error) };
    }
  });
}
