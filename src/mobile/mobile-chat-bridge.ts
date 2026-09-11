/**
 * MobileChatBridge — the paired phone as a chat surface, and the ONE inbound
 * call path from a phone into Helm's tools.
 *
 * Two directions, deliberately asymmetric:
 *
 * OUTBOUND. An agent message for a session is encoded as a `chat` record and
 * pushed to EVERY linked, enabled phone. Fan-out across phones is unconditional,
 * exactly as fan-out across surfaces is (see ChatBroker): a second device is not
 * a reason to keep a message from the first.
 *
 * INBOUND. Every record a phone sends is a `call`, and every call goes through
 * `MobileGate.handle` — there is no other route to a tool from here, and no
 * second gate. A phone's chat REPLY is therefore a `session_send_text` call,
 * gated and audited like any other, rather than a privileged side channel that
 * would have to be trusted separately. Anything that is not a well-formed call
 * from a REGISTERED machine is dropped silently: answering would tell a stranger
 * their bytes were understood.
 *
 * If no gate is wired the bridge denies rather than degrading — a missing
 * boundary must never become an open one.
 *
 * Per invariant 7's spirit, nothing here throws into the transport: every
 * failure is logged and answered (or dropped).
 */

import { logger } from '../utils/logger.js';
import { GateError, MOBILE_DENY_MESSAGE } from './mobile-gate.js';
import { decodeRecord, encodeChat, encodeError, encodeResult } from './mobile-envelope.js';
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { SessionAlertKind } from '../session/session-alert.js';

/** The provider key the phone surface owns. */
export const MOBILE_CHAT_PROVIDER = 'mobile';

const JSONRPC_SERVER_ERROR = -32000;

/** The slice of MobileLinkManager this bridge drives. Narrow by design: no BLE. */
export interface MobileMessageLinks {
  isOnline(machineId: string): boolean;
  send(machineId: string, message: Buffer): boolean;
  on(event: 'message', handler: (machineId: string, payload: Buffer) => void): unknown;
  off?(event: 'message', handler: (machineId: string, payload: Buffer) => void): unknown;
}

/** The gate's one method, resolved lazily so wiring order does not matter. */
export interface MobileCallGate {
  handle(deviceId: string, method: string, params: unknown): Promise<unknown>;
}

/** Minimal session view: a chat record names the session it belongs to. */
export interface MobileChatSessions {
  getSession(sessionId: string): { id: string; name: string } | null;
}

export interface MobileChatBridgeDeps {
  links: MobileMessageLinks;
  deviceStore: Pick<MobileDeviceStore, 'list' | 'getByMachineId'>;
  /** MUST resolve to the ONE MobileGate. Returning undefined denies everything. */
  gate: () => MobileCallGate | undefined;
  sessions: MobileChatSessions;
  now?: () => number;
}

export class MobileChatBridge implements ChatBridge {
  readonly provider = MOBILE_CHAT_PROVIDER;

  private readonly deps: MobileChatBridgeDeps;
  private readonly now: () => number;
  private readonly onMessage = (machineId: string, payload: Buffer) => {
    void this.handleInbound(machineId, payload);
  };
  private listening = false;

  constructor(deps: MobileChatBridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Begin accepting inbound records. Idempotent. */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.deps.links.on('message', this.onMessage);
  }

  /** Stop accepting inbound records. Idempotent. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.deps.links.off?.('message', this.onMessage);
  }

  isAvailable(): boolean {
    return this.linkedMachines().length > 0;
  }

  async sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    const session = this.deps.sessions.getSession(message.sessionId);
    if (!session) return { sent: false, reason: `Session not found: ${message.sessionId}` };

    const machines = this.linkedMachines();
    if (machines.length === 0) return { sent: false, reason: 'No phone is linked' };

    const payload = encodeChat({
      sessionId: session.id,
      sessionName: session.name,
      text: message.text,
      at: this.now(),
      ...(message.filePath ? { filePath: message.filePath } : {}),
      ...(message.asVoice ? { voice: true } : {}),
    });

    // Every linked phone gets it; one refusing does not cancel the others.
    const sent = machines.map(machineId => this.deps.links.send(machineId, payload));
    return sent.some(Boolean)
      ? { sent: true }
      : { sent: false, reason: 'No linked phone accepted the message' };
  }

  /**
   * Push an ALERT — something happened to a session — to every linked phone.
   *
   * The same record shape as a message, with `kind` set, which is what tells the
   * phone to raise a notification instead of appending to the thread. It goes out
   * UNCONDITIONALLY, alongside Telegram: a phone that also gets the Telegram
   * message buzzes twice, and that is ratified rather than tolerated — see
   * docs/chat-fan-out.md.
   *
   * Returns false when nothing carried it; the caller logs, nobody retries. An
   * alert is only true at the moment it happens.
   */
  sendAlert(sessionId: string, kind: SessionAlertKind, text: string): boolean {
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) return false;

    const machines = this.linkedMachines();
    if (machines.length === 0) return false;

    const payload = encodeChat({
      sessionId: session.id,
      sessionName: session.name,
      text,
      at: this.now(),
      kind,
    });

    return machines.map(machineId => this.deps.links.send(machineId, payload)).some(Boolean);
  }

  /** Enabled, registered devices this hub currently holds a link to. */
  private linkedMachines(): string[] {
    return this.deps.deviceStore
      .list()
      .filter(device => device.enabled !== false && this.deps.links.isOnline(device.machineId))
      .map(device => device.machineId);
  }

  /**
   * One inbound record. Resolves the LOCAL device record id from the machineId —
   * the gate is keyed on the record id, the link manager on the machineId, and
   * `getByMachineId` is the only bridge between the two.
   */
  private async handleInbound(machineId: string, payload: Buffer): Promise<void> {
    const device = this.deps.deviceStore.getByMachineId(machineId);
    if (!device) {
      logger.warn(`[MobileChat] Dropped a record from an unregistered machine ${machineId}`);
      return;
    }

    const record = decodeRecord(payload);
    if (!record || record.t !== 'call') {
      // A phone may only ASK. Results and chat records travel Helm → phone only.
      logger.warn(`[MobileChat] Dropped a malformed or non-call record from ${device.id}`);
      return;
    }

    const gate = this.deps.gate();
    if (!gate) {
      logger.error('[MobileChat] No MobileGate is wired — denying the call rather than dispatching it');
      this.answer(machineId, encodeError(record.id, JSONRPC_SERVER_ERROR, MOBILE_DENY_MESSAGE));
      return;
    }

    try {
      const result = await gate.handle(device.id, record.method, record.params);
      this.answer(machineId, encodeResult(record.id, result));
    } catch (err) {
      const code = err instanceof GateError ? err.code : JSONRPC_SERVER_ERROR;
      const message = err instanceof Error ? err.message : String(err);
      this.answer(machineId, encodeError(record.id, code, message));
    }
  }

  private answer(machineId: string, payload: Buffer): void {
    if (this.deps.links.send(machineId, payload)) return;
    logger.warn(`[MobileChat] Could not deliver a reply to ${machineId}; the link is gone`);
  }
}
