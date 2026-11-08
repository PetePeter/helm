/**
 * Voice IPC Handlers — desktop hold-to-talk to the Helm operator
 * (docs/voice-operator.md).
 *
 * `voice:transcribe` / `voice:speak` front the shared OpenWhispr/Piper
 * VoiceService; `voice:ask` hands the user's words to the operator. Replies come
 * back the other way on `voice:operatorReply` (see DesktopVoiceBridge).
 */
import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { VoiceConfig } from '../../config/loader.js';
import { VoiceService as DefaultVoiceService, type VoiceResult, type VoiceService } from '../../voice/voice-service.js';
import { VOICE_CONFIG_FIELDS } from '../../config/voice-config-manager.js';
import { CapabilityDetector } from '../../session/capability-detector.js';
import type { ProfileRuntime } from '../../session/profile-runtime.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { OperatorSessionManager } from '../../session/operator-session-manager.js';
import type { ChatBroker } from '../../session/chat/chat-broker.js';
import type { MobileChatBridge } from '../../mobile/mobile-chat-bridge.js';
import type { MobileChatJournal } from '../../mobile/mobile-chat-journal.js';
import type { WindowManager } from '../window-manager.js';
import { setupOperatorHandlers } from './operator-handlers.js';
import { DesktopVoiceBridge } from '../../voice/desktop-voice-bridge.js';
import { createAdminPromptDelivery } from './profile-runtime-routing.js';
import { getMainProcessAdminGuard, type AdminGuard } from './admin-guard.js';

export interface VoiceHandlerDeps {
  adminGuard?: AdminGuard;
  config: {
    getVoiceConfig: () => VoiceConfig;
    setVoiceConfig: (updates: Partial<VoiceConfig>) => void;
  };
  voiceService: Pick<VoiceService, 'transcribe' | 'speak'>;
  /** Deliver the user's spoken words to the operator. */
  ask: (text: string) => Promise<VoiceResult>;
  /** The operator's newest persisted reply, so the sidebar survives a restart. */
  lastReply: () => string | null;
}

export function setupVoiceHandlers(deps: VoiceHandlerDeps): void {
  const requireAdmin = () => (deps.adminGuard ?? getMainProcessAdminGuard()).requireAdmin();
  ipcMain.handle('voice:getConfig', () => { requireAdmin(); return deps.config.getVoiceConfig(); });

  ipcMain.handle('voice:setConfig', (_event, updates: unknown) => {
    requireAdmin();
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return { ok: false, error: 'Invalid voice config' };
    }
    const safeUpdates: Partial<VoiceConfig> = {};
    for (const field of VOICE_CONFIG_FIELDS) {
      const value = (updates as Record<string, unknown>)[field];
      if (typeof value === 'string') safeUpdates[field] = value;
    }
    deps.config.setVoiceConfig(safeUpdates);
    return { ok: true, config: deps.config.getVoiceConfig() };
  });

  ipcMain.handle('voice:transcribe', async (_event, audio: unknown, mimeType: unknown) => {
    requireAdmin();
    if (!(audio instanceof Uint8Array) || typeof mimeType !== 'string') {
      return { ok: false, error: 'Invalid audio payload' };
    }
    return deps.voiceService.transcribe(audio, mimeType);
  });

  ipcMain.handle('voice:speak', async (_event, text: unknown) => {
    requireAdmin();
    if (typeof text !== 'string') return { ok: false, error: 'Invalid text' };
    return deps.voiceService.speak(text);
  });

  ipcMain.handle('voice:lastOperatorReply', () => { requireAdmin(); return deps.lastReply(); });

  ipcMain.handle('voice:ask', async (_event, text: unknown) => {
    requireAdmin();
    if (typeof text !== 'string') return { ok: false, error: 'Nothing to send' };
    try {
      return await deps.ask(text.trim());
    } catch (error) {
      logger.error(`[IPC] voice:ask failed: ${error}`);
      return { ok: false, error: String(error) };
    }
  });
}

export function setupAdminVoiceSurface(options: {
  adminRuntime: ProfileRuntime;
  adminGuard?: AdminGuard;
  ptyManager: PtyManager;
  operatorSessionManager: OperatorSessionManager;
  chatBroker: ChatBroker;
  mobileChatBridge: MobileChatBridge;
  mobileChatJournal: MobileChatJournal;
  windowManager: WindowManager;
  tempDir: string;
}): void {
  const { adminRuntime, operatorSessionManager, chatBroker, mobileChatBridge, mobileChatJournal } = options;
  const adminGuard = options.adminGuard ?? getMainProcessAdminGuard();
  adminGuard.requireAdmin(adminRuntime.userProfileId);
  setupOperatorHandlers(adminRuntime.configLoader, operatorSessionManager, adminGuard);
  const voiceTools = new CapabilityDetector(adminRuntime.configLoader);
  chatBroker.register(new DesktopVoiceBridge({
    getOperatorId: () => operatorSessionManager.getOperatorId(),
    emitReply: reply => {
      // The admin operator keeps running after a switch; its reply belongs to
      // the admin's screen, not whichever profile is showing now.
      try { adminGuard.requireAdmin(); } catch { return; }
      const win = options.windowManager.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('voice:operatorReply', reply);
    },
  }));
  const deliverPrompt = createAdminPromptDelivery(adminRuntime, options.ptyManager, adminGuard);
  setupVoiceHandlers({
    adminGuard,
    config: adminRuntime.configLoader,
    voiceService: new DefaultVoiceService({
      getConfig: () => adminRuntime.configLoader.getVoiceConfig(),
      getTools: () => voiceTools.getVoiceTools(),
      tempDir: options.tempDir,
    }),
    lastReply: () => {
      const operatorId = operatorSessionManager.getOperatorId();
      return operatorId ? mobileChatJournal.lastSessionMessage(operatorId) : null;
    },
    ask: async text => {
      const operatorId = operatorSessionManager.getOperatorId();
      if (!operatorId) return { ok: false, error: 'The Helm operator is off — enable it in Settings → Operator' };
      await deliverPrompt(operatorId, text);
      mobileChatBridge.recordDesktopTurn(operatorId, text, randomUUID());
      return { ok: true };
    },
  });
}
