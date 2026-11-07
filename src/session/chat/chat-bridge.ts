/**
 * ChatBridge — one chat surface, whatever the transport underneath it is.
 *
 * A chat surface is a provider of the shared session chat contract. Each
 * transport implements this shape without coupling the broker to its details.
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
  /** Desktop chat turns are mirrored to users and must not be voiced back to the same desktop. */
  source?: 'desktop';
  /** Stable source id used by a surface to reconcile an echoed user turn. */
  originId?: string;
  /** Absolute path to an attachment. Bridges that cannot carry files skip it. */
  filePath?: string;
  /**
   * The SAME file as `filePath`, registered as an artifact attachment so a
   * surface that cannot read the desktop's filesystem can still fetch it.
   *
   * Two ways to name one file is deliberate, not duplication: desktop bridges
   * can use a path; a phone needs an attachment id to fetch it. Each bridge
   * takes the half it can carry, which also lets text-only bridges skip paths.
   */
  attachment?: ChatAttachmentRef;
  /** Send an audio attachment as a native voice message where supported. */
  asVoice?: boolean;
  /** How full the session's context is, shown as a badge where the surface can (the phone, the desktop pane). */
  usage?: ChatTurnUsage;
}

/**
 * The model context size after a reply. An API tool's loop reports it with the
 * turn's tool calls; a CLI's is read from its transcript (transcript-usage.ts),
 * which knows no tool count. `contextWindow` turns the size into "% full".
 */
export interface ChatTurnUsage {
  contextTokens: number;
  toolCalls?: number;
  /** API completion rounds that returned reasoning metadata. */
  thoughtCount?: number;
  contextWindow?: number;
  /** Token counts where the context graph turns amber and red (context-limits.ts). */
  contextAmber?: number;
  contextRed?: number;
}

/** Where a chat file lives once Helm owns a copy of it. */
export interface ChatAttachmentRef {
  artifactId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  generatedMedia?: boolean;
  /** Local path for desktop preview; phones always use the attachment ids. */
  filePath?: string;
}

/** Chat attachment returned by the desktop uploader, which always has a local path. */
export interface ChatUploadedAttachment extends ChatAttachmentRef {
  filePath: string;
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
   * traffic simply omits this; the broker only subscribes when
   * it is present.
   */
  on?(event: 'inbound', handler: (message: ChatInboundMessage) => void): unknown;
  off?(event: 'inbound', handler: (message: ChatInboundMessage) => void): unknown;
}
