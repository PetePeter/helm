/**
 * ChatBridge — one chat surface, whatever the transport underneath it is.
 *
 * Telegram used to BE the chat channel: the concept and the transport were the
 * same object. A phone over BLE is a second surface that runs ALONGSIDE it
 * permanently, and a LAN transport is wanted later still, so the concept is
 * lifted out here and every surface implements exactly this.
 *
 * Nothing in this file may assume how many bridges exist. Two-of-a-kind thinking
 * is how a pair-shaped assumption gets baked in and has to be unpicked when the
 * third one arrives.
 */

/** One outbound message, addressed by session rather than by topic/route. */
export interface ChatOutboundMessage {
  /** The hub session the message belongs to. Every bridge routes from this. */
  sessionId: string;
  text: string;
  /** Absolute path to an attachment. Bridges that cannot carry files skip it. */
  filePath?: string;
  /**
   * The SAME file as `filePath`, registered as an artifact attachment so a
   * surface that cannot read the desktop's filesystem can still fetch it.
   *
   * Two ways to name one file is deliberate, not duplication: Telegram uploads
   * the bytes and needs a path; a phone has no path it could ever open and
   * needs an id to ask for. Each bridge takes the half it can carry, which is
   * the same rule that already lets a text-only bridge skip `filePath`.
   */
  attachment?: ChatAttachmentRef;
  /** Send an audio attachment as a native voice message where supported. */
  asVoice?: boolean;
}

/** Where a chat file lives once Helm owns a copy of it. */
export interface ChatAttachmentRef {
  artifactId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** What one bridge reports about one send. Never throws out of a broker. */
export interface ChatSendResult {
  sent: boolean;
  reason?: string;
}

/** A per-bridge send outcome, tagged so a caller can pick out its own surface. */
export interface ChatDeliveryResult extends ChatSendResult {
  provider: string;
}

/** A message arriving FROM a chat surface, already resolved to a session. */
export interface ChatInboundMessage {
  provider: string;
  sessionId: string;
  text: string;
}

export interface ChatBridge {
  /** Stable key for this surface — also the `chatBindings` key it owns. */
  readonly provider: string;
  /** Whether the surface can carry a message right now. */
  isAvailable(): boolean;
  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult>;
  /**
   * Optional inbound stream. A bridge that already delivers its own inbound
   * traffic (Telegram does) simply omits this; the broker only subscribes when
   * it is present.
   */
  on?(event: 'inbound', handler: (message: ChatInboundMessage) => void): unknown;
  off?(event: 'inbound', handler: (message: ChatInboundMessage) => void): unknown;
}
