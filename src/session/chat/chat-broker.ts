/**
 * ChatBroker — the registry every chat surface plugs into, and the one place a
 * message fans out from.
 *
 * FAN-OUT IS UNCONDITIONAL AND RATIFIED. Every registered bridge receives every
 * message, always. There is no provider selection, no "prefer the phone when it
 * is linked", and no de-duplication: Telegram is the only out-of-BLE-range path,
 * so suppressing it when the phone happens to be online would make "was I told?"
 * depend on link state. Duplicate buzzes are the accepted cost.
 *
 * The registry is UNBOUNDED. Telegram + mobile is today's pair, a LAN transport
 * is wanted later, and nothing here may be shaped around there being two.
 *
 * One bridge failing must never silence another — a Telegram outage taking the
 * phone down with it is precisely the failure this class exists to prevent — so
 * every send is isolated and a throw is reported as a per-bridge result rather
 * than propagated.
 */

import { logger } from '../../utils/logger.js';
import type {
  ChatAttachmentRef,
  ChatBridge,
  ChatDeliveryResult,
  ChatInboundMessage,
  ChatOutboundMessage,
} from './chat-bridge.js';

/** Injected sink that puts an inbound message in front of its session's CLI. */
export type ChatInboundDeliver = (message: ChatInboundMessage) => Promise<void>;

/**
 * Injected sink that takes Helm's own copy of an outbound file and returns the
 * ids a fileless surface can fetch it by. Returns undefined when the file
 * cannot be taken — a missing path, an oversized file — which is never fatal.
 */
export type ChatAttachmentRegistrar = (
  sessionId: string,
  filePath: string,
) => ChatAttachmentRef | undefined;

export interface ChatBrokerOptions {
  deliver?: ChatInboundDeliver;
  registerAttachment?: ChatAttachmentRegistrar;
}

export class ChatBroker {
  private readonly bridges = new Map<string, ChatBridge>();
  /** Kept per provider so unregister detaches exactly the handler it attached. */
  private readonly inboundHandlers = new Map<string, (message: ChatInboundMessage) => void>();
  private readonly deliver: ChatInboundDeliver | undefined;
  private readonly registerAttachment: ChatAttachmentRegistrar | undefined;

  constructor(options: ChatBrokerOptions = {}) {
    this.deliver = options.deliver;
    this.registerAttachment = options.registerAttachment;
  }

  /** Add a surface. Re-registering a provider replaces the previous bridge. */
  register(bridge: ChatBridge): void {
    this.unregister(bridge.provider);
    this.bridges.set(bridge.provider, bridge);

    if (!bridge.on) return;
    const handler = (message: ChatInboundMessage) => this.routeInbound(message);
    this.inboundHandlers.set(bridge.provider, handler);
    bridge.on('inbound', handler);
  }

  unregister(provider: string): void {
    const bridge = this.bridges.get(provider);
    if (!bridge) return;
    const handler = this.inboundHandlers.get(provider);
    if (handler) bridge.off?.('inbound', handler);
    this.inboundHandlers.delete(provider);
    this.bridges.delete(provider);
  }

  list(): ChatBridge[] {
    return [...this.bridges.values()];
  }

  /**
   * Fan one message out to every registered bridge and report each outcome.
   * Never throws: an unavailable or failing bridge becomes a `sent: false` row.
   */
  async send(message: ChatOutboundMessage): Promise<ChatDeliveryResult[]> {
    const bridges = this.list();
    const addressed = this.withAttachment(message);
    return Promise.all(bridges.map(bridge => this.sendVia(bridge, addressed)));
  }

  /**
   * Take Helm's own copy of an outbound file ONCE, here, before fan-out.
   *
   * Once per SEND rather than once per bridge: doing it inside a bridge would
   * store the same photo twice the moment two surfaces are live, and the two
   * copies would carry different ids for one file the user sent once.
   *
   * A failure is logged and dropped, never thrown. The surfaces that can carry
   * a path are unaffected by the surfaces that cannot, and a message that has
   * lost its file is still worth far more than no message at all.
   */
  private withAttachment(message: ChatOutboundMessage): ChatOutboundMessage {
    if (!message.filePath || message.attachment || !this.registerAttachment) return message;
    try {
      const attachment = this.registerAttachment(message.sessionId, message.filePath);
      return attachment ? { ...message, attachment } : message;
    } catch (err) {
      logger.warn(`[ChatBroker] Could not register a chat attachment: ${err}`);
      return message;
    }
  }

  private async sendVia(bridge: ChatBridge, message: ChatOutboundMessage): Promise<ChatDeliveryResult> {
    if (!bridge.isAvailable()) {
      return { provider: bridge.provider, sent: false, reason: `${bridge.provider} is not available` };
    }
    try {
      const result = await bridge.sendToSession(message);
      return { provider: bridge.provider, ...result };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[ChatBroker] ${bridge.provider} failed to send: ${reason}`);
      return { provider: bridge.provider, sent: false, reason };
    }
  }

  /**
   * Put an inbound message in front of its session. Fire-and-forget by design —
   * a bridge's receive path must not block on PTY delivery, and a failure here
   * is logged rather than thrown back into a transport callback.
   */
  routeInbound(message: ChatInboundMessage): void {
    if (!this.deliver) {
      logger.warn(`[ChatBroker] Dropped inbound ${message.provider} message: no delivery sink wired`);
      return;
    }
    void this.deliver(message).catch((err) => {
      logger.warn(`[ChatBroker] Failed to deliver inbound ${message.provider} message: ${err}`);
    });
  }
}
