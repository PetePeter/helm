/**
 * MobileChatBridge — the paired phone as a chat surface, and the ONE inbound
 * call path from a phone into Helm's tools.
 *
 * Two directions, deliberately asymmetric:
 *
 * OUTBOUND. An agent message for a session is encoded as a `chat` record and
 * pushed to EVERY linked, enabled phone. Fan-out across phones is unconditional,
 * exactly as fan-out across surfaces is (see ChatBroker): a second device is not
 * a reason to keep a message from the first. Every message is also appended to
 * the journal — once, delivered or not — and stamped with its `seq`, which is
 * what a phone that missed the live send catches up from.
 *
 * CATCH-UP. On link up a phone reports the last seq it holds with the reserved
 * `__chat_cursor__` call; the gate answers it (so a disabled device gets nothing)
 * and this bridge then replays the journal gap over the same link, oldest first.
 * See docs/chat-fan-out.md.
 *
 * INBOUND. Every record a phone sends is a `call`, and every call goes through
 * `MobileGate.handle` — there is no other route to a tool from here, and no
 * second gate. A phone's chat REPLY is therefore a `session_send_text` call,
 * gated like any other, rather than a privileged side channel that
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
import { GateError, MOBILE_DENY_MESSAGE, RESERVED_CHAT_CURSOR_METHOD } from './mobile-gate.js';
import {
  BLOB_UPLOAD_MIN_PROTOCOL,
} from './protocol-version.js';
import { decodeBlobResult, decodeRecord, encodeBlobResult, encodeChat, encodeError, encodeResult, isBlobPayload } from './mobile-envelope.js';
import type { ChatRecordInput, MobileCallRecord } from './mobile-envelope.js';
import type { MobileArtifactUploadService } from './mobile-artifact-upload.js';
import { isArtifactDownloadBinary } from '../session/artifact-download.js';
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { MobileDeviceStore } from './mobile-device-store.js';
import type { MobileChatJournal } from './mobile-chat-journal.js';
import type { SessionAlertKind } from '../session/session-alert.js';

/** The provider key the phone surface owns. */
export const MOBILE_CHAT_PROVIDER = 'mobile';

/**
 * The one tool whose accepted calls are conversation, not just effects — the
 * phone's chat reply. Spelled here because recognising it is what lets a
 * phone's own words survive into the journal.
 */
const SESSION_SEND_TEXT_METHOD = 'session_send_text';

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
  getSession(sessionId: string): { id: string; name: string; interactionChannel?: 'telegram' | 'desktop' } | null;
  /** The single mutation this bridge needs: mark where the conversation moved. */
  updateSession(sessionId: string, patch: { interactionChannel: 'telegram' | 'desktop' }): unknown;
}

export interface MobileChatBridgeDeps {
  links: MobileMessageLinks;
  deviceStore: Pick<MobileDeviceStore, 'list' | 'getByMachineId'>;
  /** MUST resolve to the ONE MobileGate. Returning undefined denies everything. */
  gate: () => MobileCallGate | undefined;
  sessions: MobileChatSessions;
  /** Every journaled message is appended here once, delivered or not. */
  journal: MobileChatJournal;
  /**
   * The protocol-4 upload reassembler. ABSENT means uploads do not exist on
   * this link set, and an inbound blob is dropped like any other malformed
   * record — a missing feature must never become an open door.
   */
  uploads?: MobileArtifactUploadService;
  /**
   * The protocol version the link to a machineId negotiated. Absent means 0:
   * nothing was negotiated, so no upload may be accepted. The slot itself was
   * opened through the gate — this check is what keeps a phone on an OLD
   * protocol from pushing bytes at a reassembler its handshake never agreed to.
   */
  negotiatedProtocol?: (machineId: string) => number;
  now?: () => number;
}

export class MobileChatBridge implements ChatBridge {
  readonly provider = MOBILE_CHAT_PROVIDER;

  private readonly deps: MobileChatBridgeDeps;
  private readonly now: () => number;
  private readonly onMessage = (machineId: string, payload: Buffer) => {
    void this.handleInbound(machineId, payload).catch((error) => {
      logger.error(`[MobileChat] Unhandled inbound processing failure for ${machineId}: ${describe(error)}`);
    });
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

    const input: ChatRecordInput = {
      sessionId: session.id,
      sessionName: session.name,
      text: message.text,
      at: this.now(),
      ...(message.filePath ? { filePath: message.filePath } : {}),
      ...(message.asVoice ? { voice: true } : {}),
      // The ids are what the phone can actually act on; the path beside them is
      // another machine's filesystem and has never been fetchable from here.
      ...(message.attachment
        ? {
            artifactId: message.attachment.artifactId,
            attachmentId: message.attachment.attachmentId,
            filename: message.attachment.filename,
            mimeType: message.attachment.mimeType,
            sizeBytes: message.attachment.sizeBytes,
          }
        : {}),
    };

    // Journaled BEFORE anyone is told, with its seq: the seq is what a phone
    // that missed this live send will ask to catch up from. Appending once,
    // here, regardless of how many phones take it — and regardless of whether
    // ANY do — is the whole reason the journal and the fan-out row can stay
    // honest independently.
    const { seq } = this.deps.journal.append(input);
    const payload = encodeChat({ ...input, seq });

    // Checked AFTER the append, not before: a message no phone was online to
    // take is precisely the one the journal exists to keep. The row below stays
    // as honest as it ever was — not-sent with today's reason.
    const machines = this.linkedMachines();
    if (machines.length === 0) return { sent: false, reason: 'No phone is linked' };

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

  /**
   * Push an ARTIFACT notice — one of the session's artifacts was created or
   * revised. The same alert shape as `sendAlert`, carrying `kind: 'artifact'`
   * plus the artifact id and title so the phone can key its row on the artifact
   * rather than the session. Fire-and-forget like every other push: a notice is
   * only true while it happens.
   */
  sendArtifact(sessionId: string, artifactId: string, title: string): boolean {
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) return false;

    const machines = this.linkedMachines();
    if (machines.length === 0) return false;

    const payload = encodeChat({
      sessionId: session.id,
      sessionName: session.name,
      text: title,
      at: this.now(),
      artifactId,
      title,
      kind: 'artifact',
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
    logger.info(`[MobileChat] Inbound record received from ${machineId} bytes=${payload.length}`);
    const device = this.deps.deviceStore.getByMachineId(machineId);
    if (!device) {
      logger.warn(`[MobileChat] Dropped a record from an unregistered machine ${machineId}`);
      return;
    }

    // An upload slice (protocol 4). Not a call, so not gate material: it fills
    // a slot only a gated call could have opened, and it answers nothing — the
    // commit call does. Refused silently, like any other record this side does
    // not understand, when the link or this hub never agreed to uploads.
    if (isBlobPayload(payload)) {
      this.takeUploadSlice(machineId, device.id, payload);
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
      logger.info(`[MobileChat] Dispatching ${record.method} id=${record.id} from ${machineId}`);
      const result = await gate.handle(device.id, record.method, record.params);
      logger.info(`[MobileChat] Dispatch completed ${record.method} id=${record.id} from ${machineId}`);
      // A download answers with FILE BYTES, which JSON can only carry as base64.
      // The gate has already run — this is purely how the ANSWER is written.
      this.answer(
        machineId,
        isArtifactDownloadBinary(result)
          ? encodeBlobResult({ id: record.id, ...result })
          : encodeResult(record.id, result),
      );
      // The cursor call answers with nothing useful — its MEANING is the replay
      // it licenses. It runs only after the gate said yes, which is what keeps
      // a disabled device from pulling the journal; see RESERVED_CHAT_CURSOR_METHOD.
      if (record.method === RESERVED_CHAT_CURSOR_METHOD) {
        this.replayAfter(machineId, cursorIn(record.params));
      }
      // An ACCEPTED reply from a phone is part of the conversation the journal
      // exists to preserve — without this, a refetch after an app restart would
      // restore only the agent's half of every thread. Journaled ONLY: nothing
      // is live-fanned to the other phones, whose own catch-up will pick the
      // echo up; the phone that sent it recognises and drops it by originId.
      if (record.method === SESSION_SEND_TEXT_METHOD) {
        this.markChannelAffinity(record);
        this.journalPhoneReply(machineId, record);
      }
    } catch (err) {
      const code = err instanceof GateError ? err.code : JSONRPC_SERVER_ERROR;
      const message = err instanceof Error ? err.message : String(err);
      this.answer(machineId, encodeError(record.id, code, message));
    }
  }

  /**
   * One inbound blob, read as an upload slice. The order of the refusals is the
   * order they are cheapest to be wrong about: protocol first (a version-3 link
   * never agreed to carry uploads, whatever slots exist), then the reassembler,
   * then the record itself.
   */
  private takeUploadSlice(machineId: string, deviceId: string, payload: Buffer): void {
    const negotiated = this.deps.negotiatedProtocol?.(machineId) ?? 0;
    if (negotiated < BLOB_UPLOAD_MIN_PROTOCOL) {
      logger.warn(`[MobileChat] Dropped an upload slice from ${deviceId}: the link negotiated ${negotiated}`);
      return;
    }
    const uploads = this.deps.uploads;
    if (!uploads) {
      logger.warn(`[MobileChat] Dropped an upload slice from ${deviceId}: no upload service is wired`);
      return;
    }
    const blob = decodeBlobResult(payload);
    if (!blob) {
      logger.warn(`[MobileChat] Dropped an unreadable upload slice from ${deviceId}`);
      return;
    }
    const outcome = uploads.acceptSlice(deviceId, blob);
    if (!outcome.ok) {
      logger.warn(`[MobileChat] Refused an upload slice from ${deviceId}: ${outcome.reason}`);
      return;
    }
    logger.info(
      `[MobileChat] Upload ${blob.id.slice(0, 8)}… at ${outcome.received}/${outcome.total}` +
        `${outcome.complete ? ' (complete)' : ''}`,
    );
  }

  /**
   * A message from the phone moves the conversation off the desktop. Set the
   * SAME channel value the Telegram relay sets — 'telegram', deliberately not
   * a new enum member — so consumers keying on "not at the desktop" (the G2
   * phone-deny) see both surfaces alike. Only written on the transition, the
   * way the relay does; a session already talking to a phone is left alone.
   */
  private markChannelAffinity(record: MobileCallRecord): void {
    const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? record.params as Record<string, unknown>
      : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (!sessionId) return;
    const session = this.deps.sessions.getSession(sessionId);
    if (!session || session.interactionChannel === 'telegram') return;
    this.deps.sessions.updateSession(sessionId, { interactionChannel: 'telegram' });
  }

  /**
   * Echo one accepted phone reply into the journal, marked with where it came
   * from. The id is the phone's OWN call id prefixed with its machineId —
   * stable enough for the sender to drop the replayed echo, and namespaced so
   * two phones that number their calls alike can never drop each other's.
   * Anything malformed (no session, no text) is skipped rather than journaled
   * as a half-record; the reply itself has already been delivered or denied by
   * the gate either way.
   */
  private journalPhoneReply(machineId: string, record: MobileCallRecord): void {
    const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? record.params as Record<string, unknown>
      : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const text = typeof params.text === 'string' ? params.text : undefined;
    if (sessionId === undefined || text === undefined) return;
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) return;

    this.deps.journal.append({
      sessionId: session.id,
      sessionName: session.name,
      text,
      at: this.now(),
      originId: `${machineId}:${record.id}`,
    });
  }

  private answer(machineId: string, payload: Buffer): void {
    logger.info(`[MobileChat] Sending reply to ${machineId} bytes=${payload.length}`);
    if (this.deps.links.send(machineId, payload)) return;
    logger.warn(`[MobileChat] Could not deliver a reply to ${machineId}; the link is gone`);
  }

  /**
   * Stream everything the phone's cursor says it is missing, oldest first.
   *
   * Oldest first because the cursor is the ONLY progress marker: a phone that
   * gets 5..9 and dies at 7 reports 6 next time, which is correct only if the
   * order was never scrambled. A send that fails stops the stream — the phone
   * re-reports its cursor on the next link up and takes the remainder then;
   * that re-request IS the retry story, so none is attempted here. Repeats a
   * live send may already have delivered (messages fanned out between the
   * cursor's read and this stream) are the phone's to dedupe by seq.
   */
  private replayAfter(machineId: string, cursor: number): void {
    const entries = this.deps.journal.since(cursor);
    if (entries.length === 0) return;
    logger.info(`[MobileChat] Replaying ${entries.length} journaled message(s) after seq ${cursor} to ${machineId}`);
    for (const entry of entries) {
      // A stop on failure is the contract: the phone will ask again from where
      // it got to. Its cursor cannot have passed what it never received.
      // `replay` rides along: everything here is old news by construction, and
      // the phone must not buzz for a backlog it asked to be given.
      if (!this.deps.links.send(machineId, encodeChat({ ...entry.record, seq: entry.seq, replay: true }))) {
        logger.warn(`[MobileChat] Replay to ${machineId} stopped at seq ${entry.seq}; the link refused a send`);
        return;
      }
    }
  }
}

/**
 * The seq a cursor call reports. Params cross as JSON, but the phone's own
 * encoder types param values, so both a number and its string form are legal —
 * a cursor that cannot be read is ZERO (fetch everything), never an error:
 * missing history is the failure this exists to prevent.
 */
function cursorIn(params: unknown): number {
  const value = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).seq
    : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  return 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
