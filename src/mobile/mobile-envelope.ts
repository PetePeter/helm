/**
 * mobile-envelope — the application records that ride inside a mobile
 * SecureChannel message.
 *
 * THIS CROSSES THE WIRE. The Kotlin app parses exactly these bytes, and the two
 * sides are built without ever meeting, so the encoding is deterministic (fixed
 * key order, no optional-field reordering, UTF-8 JSON) and pinned by committed
 * vectors at `tests/fixtures/mobile-envelope-vectors.json`. Changing a field
 * name, a key order or a type is a WIRE BREAK.
 *
 * There are exactly four record kinds, and the split is a security boundary as
 * much as a protocol one:
 *
 *   call   phone → Helm. A tool invocation. EVERY inbound record is one of
 *          these, including "send this text to a session" — a phone reply is a
 *          `session_send_text` call, not a privileged side channel. That is what
 *          makes "no path skips MobileGate" true by construction rather than by
 *          discipline.
 *   result Helm → phone. The gate's return value for one call id.
 *   error  Helm → phone. A JSON-RPC-shaped failure for one call id. Deny
 *          messages stay uniform; nothing here widens what a phone learns.
 *   chat   Helm → phone. An unsolicited agent message for a session. Carries no
 *          id: it answers nothing.
 *   lan    Helm → phone. Where this desktop can be reached over the network.
 *          Carries no id: it answers nothing. See MobileAddressAdvertiser — it
 *          rides the ALREADY AUTHENTICATED channel, which is the only reason a
 *          phone may believe an address at all.
 *
 * Decoding NEVER throws. A malformed record from a paired-but-buggy phone must
 * be dropped and logged, not propagated into the session layer.
 */

import type { SessionAlertKind } from '../session/session-alert.js';

/**
 * Everything a chat record's `kind` can say. The three session-alert classes
 * are mirrored in Kotlin's `AlertKind`; 'artifact' was added when artifacts
 * learned to push. A phone that predates a new value must degrade to an
 * ordinary notification, never drop the record.
 */
export type MobileChatKind = SessionAlertKind | 'artifact';

/** Bumped only for a breaking change to these records. */
export const MOBILE_ENVELOPE_VERSION = 1;

/** Refuse absurd records before allocating anything — 1 MiB of JSON is already
 *  four times the BLE framing cap, so anything larger is a bug or an attack. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

export interface MobileCallRecord {
  v: number;
  t: 'call';
  /** Correlates the result/error. Opaque to Helm; the phone chooses it. */
  id: string;
  method: string;
  params?: unknown;
}

export interface MobileResultRecord {
  v: number;
  t: 'result';
  id: string;
  result: unknown;
}

export interface MobileErrorRecord {
  v: number;
  t: 'error';
  id: string;
  error: { code: number; message: string };
}

export interface MobileChatRecord {
  v: number;
  t: 'chat';
  sessionId: string;
  sessionName: string;
  text: string;
  /** Epoch milliseconds the message was produced. */
  at: number;
  /** Absolute path of an attachment the phone may fetch separately. */
  filePath?: string;
  /** The attachment is a voice note rather than a plain file. */
  voice?: boolean;
  /**
   * Present turns this record from a MESSAGE into an ALERT.
   *
   * Absent (the default, and every committed vector) means an agent said this
   * and it belongs in the phone's chat thread. Present means Helm is reporting
   * an event — a state change, a flash, an artifact changing — and the phone
   * posts a notification and puts NOTHING in the thread: a reported event
   * rendered as an agent bubble would fabricate a conversation the desktop
   * never had.
   *
   * Additive and optional, so no vector was regenerated — the same precedent as
   * `SessionSummary.activityLevel`. It is emitted LAST, after the other optional
   * keys, because key order is part of this format.
   */
  kind?: MobileChatKind;
  /**
   * Identifies the artifact a `kind: 'artifact'` record is about, with its
   * title. The phone keys its notification row on the artifact id, so several
   * notices from one session REPLACE rather than pile up. Omitted for every
   * other kind; emitted before `kind` for the key-order rule above.
   */
  artifactId?: string;
  title?: string;
}

/**
 * Where Helm can be reached over the network (P-0752).
 *
 * The phone dials, so the phone holds the address — and the list would rot the
 * day the desktop's DHCP lease moved. Pushing it down the channel we already
 * trust makes it self-healing without mDNS, which cannot cross a VPN.
 *
 * An EMPTY list is meaningful and must be honoured: it says "stop dialling",
 * which is how disabling LAN reaches a phone that is connected right now.
 */
export interface MobileLanRecord {
  v: number;
  t: 'lan';
  /** `host:port` strings, in no particular order. The phone may try any. */
  addresses: string[];
}

export type MobileRecord =
  | MobileCallRecord
  | MobileResultRecord
  | MobileErrorRecord
  | MobileChatRecord
  | MobileLanRecord;

export interface ChatRecordInput {
  sessionId: string;
  sessionName: string;
  text: string;
  at: number;
  filePath?: string;
  voice?: boolean;
  kind?: MobileChatKind;
  artifactId?: string;
  title?: string;
}

/**
 * Build each record with its keys assigned in a FIXED order, so two encoders in
 * two languages produce byte-identical JSON. Optional keys are appended last and
 * omitted entirely when absent — never emitted as null.
 */
export function encodeCall(id: string, method: string, params?: unknown): Buffer {
  const record: MobileCallRecord = { v: MOBILE_ENVELOPE_VERSION, t: 'call', id, method };
  if (params !== undefined) record.params = params;
  return encode(record);
}

export function encodeResult(id: string, result: unknown): Buffer {
  return encode({ v: MOBILE_ENVELOPE_VERSION, t: 'result', id, result: result ?? null });
}

export function encodeError(id: string, code: number, message: string): Buffer {
  return encode({ v: MOBILE_ENVELOPE_VERSION, t: 'error', id, error: { code, message } });
}

export function encodeChat(input: ChatRecordInput): Buffer {
  const record: MobileChatRecord = {
    v: MOBILE_ENVELOPE_VERSION,
    t: 'chat',
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    text: input.text,
    at: input.at,
  };
  if (input.filePath !== undefined) record.filePath = input.filePath;
  if (input.voice) record.voice = true;
  if (input.artifactId !== undefined) record.artifactId = input.artifactId;
  if (input.title !== undefined) record.title = input.title;
  if (input.kind !== undefined) record.kind = input.kind;
  return encode(record);
}

/** Addresses are emitted in the order given; the phone must not assume one. */
export function encodeLan(addresses: string[]): Buffer {
  return encode({ v: MOBILE_ENVELOPE_VERSION, t: 'lan', addresses });
}

function encode(record: MobileRecord): Buffer {
  return Buffer.from(JSON.stringify(record), 'utf8');
}

/**
 * Parse one record. Returns null for anything that is not a well-formed record
 * of a version this build understands — never throws, never partially applies.
 */
export function decodeRecord(payload: Buffer): MobileRecord | null {
  if (payload.length === 0 || payload.length > MAX_ENVELOPE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record.v !== MOBILE_ENVELOPE_VERSION) return null;

  switch (record.t) {
    case 'call':
      return isString(record.id) && isString(record.method)
        ? ({ ...record } as unknown as MobileCallRecord)
        : null;
    case 'result':
      return isString(record.id) && 'result' in record
        ? ({ ...record } as unknown as MobileResultRecord)
        : null;
    case 'error':
      return isString(record.id) && isErrorBody(record.error)
        ? ({ ...record } as unknown as MobileErrorRecord)
        : null;
    case 'chat':
      return isString(record.sessionId) && isString(record.sessionName)
        && isString(record.text) && typeof record.at === 'number'
        ? ({ ...record } as unknown as MobileChatRecord)
        : null;
    case 'lan':
      // An empty array is VALID — it means "stop dialling". Only a non-array,
      // or an array holding anything but strings, is malformed.
      return Array.isArray(record.addresses) && record.addresses.every(isString)
        ? ({ ...record } as unknown as MobileLanRecord)
        : null;
    default:
      return null;
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isErrorBody(value: unknown): value is { code: number; message: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { code?: unknown }).code === 'number'
    && isString((value as { message?: unknown }).message);
}
