/**
 * DesktopVoiceBridge — the desktop's speakers as one more chat surface.
 *
 * The operator answers the way it answers the phone: `chat_send`. Registering
 * here, rather than tapping the MCP tool, means the desktop receives exactly
 * what every other surface receives through the one ChatBroker fan-out, and the
 * phone and desktop can never disagree about what Helm said.
 *
 * Only the operator is voiced. Every other session's message is declined, so an
 * ordinary worker's chat_send never talks out of the desktop.
 */
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';

export const DESKTOP_VOICE_PROVIDER = 'desktop-voice';

export interface OperatorReply {
  sessionId: string;
  text: string;
}

export interface DesktopVoiceBridgeDeps {
  /** The live operator session id, or null when the operator is off. */
  getOperatorId: () => string | null;
  /** Hand the reply to the renderer (webContents.send in production). */
  emitReply: (reply: OperatorReply) => void;
}

export class DesktopVoiceBridge implements ChatBridge {
  readonly provider = DESKTOP_VOICE_PROVIDER;

  constructor(private readonly deps: DesktopVoiceBridgeDeps) {}

  isAvailable(): boolean {
    return this.deps.getOperatorId() !== null;
  }

  async sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    if (message.sessionId !== this.deps.getOperatorId()) {
      return { sent: false, reason: 'desktop voice only carries the Helm operator' };
    }
    const text = message.text.trim();
    if (!text) return { sent: false, reason: 'nothing to speak' };
    this.deps.emitReply({ sessionId: message.sessionId, text });
    return { sent: true };
  }
}
