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

export interface VoiceHandlerDeps {
  voiceService: Pick<VoiceService, 'transcribe' | 'speak'>;
  /** Deliver the user's words to the operator; resolves to a result value. */
  ask: (text: string) => Promise<VoiceResult>;
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

  ipcMain.handle('voice:ask', async (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'Nothing to send' };
    try {
      return await deps.ask(text.trim());
    } catch (error) {
      logger.error(`[IPC] voice:ask failed: ${error}`);
      return { ok: false, error: String(error) };
    }
  });
}
