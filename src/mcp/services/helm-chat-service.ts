import * as fs from 'fs';
import * as path from 'path';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionManager } from '../../session/manager.js';
import type { ChatBroker } from '../../session/chat/chat-broker.js';
import type { ChatOutboundMessage, ChatTurnUsage } from '../../session/chat/chat-bridge.js';
import { resolveSessionContextSize } from '../../session/context-size.js';
import { resolveContextLimits } from '../../session/context-limits.js';
import type { SessionInfo } from '../../types/session.js';

export type ChatAttachmentInspection =
  | { valid: true; size: number }
  | { valid: false; reason: string };

/** Shared generic path checks let a transport wrapper inspect size after validation. */
export function inspectChatAttachment(filePath: string): ChatAttachmentInspection {
  if (!path.isAbsolute(filePath)) return { valid: false, reason: 'File path must be absolute' };
  if (!fs.existsSync(filePath)) return { valid: false, reason: `File not found: ${filePath}` };
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) return { valid: false, reason: `Not a file: ${filePath}` };
  return { valid: true, size: stats.size };
}

/** Transport-neutral chat sends addressed to the caller's own Helm session. */
export class HelmChatService {
  private chatBroker: ChatBroker | null = null;

  constructor(
    private readonly configLoader: ConfigLoader,
    private readonly sessionManager: SessionManager,
  ) {}

  setChatBroker(broker: ChatBroker | null): void {
    this.chatBroker = broker;
  }

  async sendChat(
    sessionRef: string,
    message: string,
    filePath?: string,
    usage?: ChatTurnUsage,
  ): Promise<{ sent: boolean; reason?: string }> {
    if (filePath) {
      const attachment = inspectChatAttachment(filePath);
      if (!attachment.valid) return { sent: false, reason: attachment.reason };
    }

    // Chat replies are addressed by session ID only; names are never resolved.
    const session = this.sessionManager.getSession(sessionRef);
    if (!session) return { sent: false, reason: `Session not found by ID: ${sessionRef}` };

    const badge = this.usageBadge(session, usage);
    return this.fanOut({
      sessionId: session.id,
      text: message,
      ...(filePath ? { filePath } : {}),
      ...(badge ? { usage: badge } : {}),
    });
  }

  private async fanOut(message: ChatOutboundMessage): Promise<{ sent: boolean; reason?: string }> {
    if (!this.chatBroker) return { sent: false, reason: 'No chat surface is registered' };

    const results = await this.chatBroker.send(message);
    if (results.some(result => result.sent)) return { sent: true };
    const reason = results
      .map(result => `${result.provider}: ${result.reason ?? 'not sent'}`)
      .join('; ');
    return { sent: false, reason: reason || 'No chat surface is registered' };
  }

  private usageBadge(session: SessionInfo, reported: ChatTurnUsage | undefined): ChatTurnUsage | undefined {
    const cliEntry = this.configLoader.getCliTypeEntry(session.cliType);
    const usage = this.contextUsage(session, reported, cliEntry);
    const limits = usage && resolveContextLimits(cliEntry, usage.contextWindow);
    return limits ? { ...usage, contextAmber: limits.amber, contextRed: limits.red } : usage;
  }

  private contextUsage(
    session: SessionInfo,
    reported: ChatTurnUsage | undefined,
    cliEntry: ReturnType<ConfigLoader['getCliTypeEntry']>,
  ): ChatTurnUsage | undefined {
    if (!reported && session.contextUsage?.source === 'statusline') {
      return {
        contextTokens: session.contextUsage.tokens,
        ...(session.contextUsage.window !== undefined ? { contextWindow: session.contextUsage.window } : {}),
      };
    }
    if (reported) {
      const contextWindow = reported.contextWindow ?? cliEntry?.contextWindow;
      return contextWindow ? { ...reported, contextWindow } : reported;
    }

    const context = resolveSessionContextSize({
      cliTranscriptPath: session.cliTranscriptPath,
      provider: cliEntry?.provider,
      apiTool: session.apiTool,
      comfyUiTool: session.comfyUiTool,
      remote: session.remote,
    }, { contextWindow: cliEntry?.contextWindow });
    if (!context.known) return undefined;
    return {
      contextTokens: context.tokens,
      ...(context.window !== undefined ? { contextWindow: context.window } : {}),
    };
  }
}
