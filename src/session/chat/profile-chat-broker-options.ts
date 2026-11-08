import { logger } from '../../utils/logger.js';
import type { PtyManager } from '../pty-manager.js';
import type { ProfileRuntimeRegistry } from '../profile-runtime-registry.js';
import { deliverPromptSequenceToSession } from '../sequence-delivery.js';
import { createChatAttachmentRegistrar } from './chat-attachment-registrar.js';
import type { ChatBrokerOptions } from './chat-broker.js';

/** Build the shared broker's profile-aware callbacks. */
export function createProfileChatBrokerOptions(
  registry: Pick<ProfileRuntimeRegistry, 'findSessionOwner'>,
  ptyManager: PtyManager,
): ChatBrokerOptions {
  const attachmentRegistrars = new Map<string, ReturnType<typeof createChatAttachmentRegistrar>>();

  return {
    deliver: async message => {
      const runtime = registry.findSessionOwner(message.sessionId);
      const target = runtime?.sessionManager.getSession(message.sessionId);
      if (!runtime || !target) {
        logger.warn(`[chat] Dropped an inbound ${message.provider} message for unknown session ${message.sessionId}`);
        return;
      }
      await deliverPromptSequenceToSession({
        sessionId: target.id,
        text: message.text,
        ptyManager,
        sessionManager: runtime.sessionManager,
        configLoader: runtime.configLoader,
      });
    },
    registerAttachment: (sessionId, filePath) => {
      const runtime = registry.findSessionOwner(sessionId);
      if (!runtime) return undefined;
      let registrar = attachmentRegistrars.get(runtime.userProfileId);
      if (!registrar) {
        registrar = createChatAttachmentRegistrar({
          artifacts: runtime.artifactManager,
          attachments: runtime.artifactAttachmentManager,
        });
        attachmentRegistrars.set(runtime.userProfileId, registrar);
      }
      return registrar(sessionId, filePath);
    },
  };
}
