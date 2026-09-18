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
 *   blob   Helm → phone by default: a download reply, and the ONE record that
 *          is not JSON — a marker byte, a small JSON header and then RAW bytes.
 *          See `encodeBlobResult` for why. Under PROTOCOL 4 the SAME frame may
 *          travel phone → Helm as an UPLOAD slice; `decodeRecord` still refuses
 *          it there, because an upload is never dispatched through the gate —
 *          the bridge hands it to the upload service by its slot id. See
 *          `mobile-artifact-upload.ts`.
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
  /**
   * An attached FILE the phone may fetch, named by ids rather than by a path.
   *
   * `filePath` above is the same file as the desktop sees it, and the phone has
   * never been able to open it — it is another machine's filesystem. These keys
   * are what the phone CAN act on: `artifactId` + `attachmentId` address a
   * `session_artifact_download`, which answers in slices, so a file far larger
   * than a frame still crosses. The metadata rides along so the tile can show a
   * name and a size before anything is fetched.
   *
   * Emitted after `kind` to keep the byte-identical key order the cross-language
   * vectors pin. `filePath` keeps being emitted beside them: it costs one string
   * and it is what an older phone build already expects.
   */
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  /**
   * The message's place in the hub's global chat journal — what a phone's
   * catch-up cursor is measured against. Present on every JOURNALED message;
   * absent on alerts, which are never journaled and never replayed. A phone
   * treats a record without one as "no cursor update", so an old hub degrades
   * to live-only behaviour rather than to a stuck cursor.
   *
   * Additive and omitted when absent, so every committed vector still encodes
   * byte-identically and no vector was regenerated. Emitted after `sizeBytes`,
   * before the keys that postdate it, because key order is part of this format.
   */
  seq?: number;
  /**
   * Marks a record as a PHONE'S OWN message, echoed into the journal when the
   * hub accepted its `session_send_text` call — the value is that call's id,
   * prefixed with the phone's machineId so two phones that happen to number
   * their calls alike can never collide. The phone that sent it drops the
   * replayed echo by this id; other phones render it as a phone-side message.
   * Absent on agent messages and alerts.
   */
  originId?: string;
  /**
   * True ONLY on records streamed from the journal during catch-up — live
   * fan-out never carries it. It is the phone's cue to file the message without
   * buzzing: everything in a replay is, by construction, old news. Absent
   * (the default) means live.
   */
  replay?: boolean;
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
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  seq?: number;
  originId?: string;
  replay?: boolean;
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
  if (input.attachmentId !== undefined) record.attachmentId = input.attachmentId;
  if (input.filename !== undefined) record.filename = input.filename;
  if (input.mimeType !== undefined) record.mimeType = input.mimeType;
  if (input.sizeBytes !== undefined) record.sizeBytes = input.sizeBytes;
  // Last, always: these postdate every committed vector, and emitting any of
  // them in an earlier slot would reorder the bytes an older phone build
  // already expects. Order among themselves: seq, originId, replay.
  if (input.seq !== undefined) record.seq = input.seq;
  if (input.originId !== undefined) record.originId = input.originId;
  if (input.replay !== undefined) record.replay = input.replay;
  return encode(record);
}

/**
 * The download reply, and the ONE record on this wire that is not JSON.
 *
 * WHY: a download answers with FILE BYTES, and a JSON record can only carry them
 * as base64 — 4 chars per 3 bytes, a third more wire for nothing, on top of an
 * encode on one side and a decode on the other. At 10MB that was 111 round trips
 * of inflated text. Raw bytes make the same transfer ~11.
 *
 * The frame is:
 *
 *   byte 0      BLOB_MARKER — never '{' (0x7b), so a reader can tell this from a
 *               JSON record by its FIRST byte and neither codec has to guess.
 *   byte 1      BLOB_RECORD_VERSION.
 *   bytes 2..3  uint16be header length.
 *   header      UTF-8 JSON, fixed key order, exactly like every other record.
 *   rest        the RAW body. `size` in the header is its length.
 *
 * Helm → phone ONLY — except under protocol 4, where the same frame carries an
 * UPLOAD slice the other way (see `BLOB_UPLOAD_MIN_PROTOCOL` in
 * protocol-version.ts). The JSON `call` path never sees a blob either way:
 * `decodeRecord` refuses the marker byte, and the bridge routes an inbound one
 * to the upload service instead of the gate.
 */
export const BLOB_MARKER = 0xb1;

/** Bumped only for a breaking change to the binary layout above. */
export const BLOB_RECORD_VERSION = 1;

/** The header is length-prefixed as a uint16, so it cannot exceed one. */
export const BLOB_HEADER_PREFIX_BYTES = 4;

export interface MobileBlobResult {
  /** The call id this answers — the same correlation a result record carries. */
  id: string;
  filename: string;
  mimeType: string;
  /** The raw body. */
  bytes: Buffer;
  /** The artifact version, when the body is an artifact rather than a slice. */
  version?: number;
  /** Where this slice starts in the file. Sliced fetches only. */
  offset?: number;
  /** The whole file's length. Sliced fetches only. */
  total?: number;
  /** True when nothing follows this slice. Sliced fetches only. */
  eof?: boolean;
}

/** Key order is part of the format here too — optional keys last, never null. */
export function encodeBlobResult(blob: MobileBlobResult): Buffer {
  const header: Record<string, unknown> = {
    v: MOBILE_ENVELOPE_VERSION,
    t: 'blob',
    id: blob.id,
    filename: blob.filename,
    mimeType: blob.mimeType,
    size: blob.bytes.length,
  };
  if (blob.version !== undefined) header.version = blob.version;
  if (blob.offset !== undefined) header.offset = blob.offset;
  if (blob.total !== undefined) header.total = blob.total;
  if (blob.eof !== undefined) header.eof = blob.eof;

  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length > 0xffff) {
    throw new Error(`blob header of ${headerBytes.length} bytes exceeds the uint16 length prefix`);
  }
  const prefix = Buffer.alloc(BLOB_HEADER_PREFIX_BYTES);
  prefix[0] = BLOB_MARKER;
  prefix[1] = BLOB_RECORD_VERSION;
  prefix.writeUInt16BE(headerBytes.length, 2);
  return Buffer.concat([prefix, headerBytes, blob.bytes]);
}

/** Whether a payload is a blob record, decided on its first byte alone. */
export function isBlobPayload(payload: Buffer): boolean {
  return payload.length > 0 && payload[0] === BLOB_MARKER;
}

/**
 * Parse one blob record. Like `decodeRecord` it NEVER throws — a truncated or
 * mislabelled body is dropped, because the link outlives its payloads.
 */
export function decodeBlobResult(payload: Buffer): MobileBlobResult | null {
  if (!isBlobPayload(payload) || payload.length < BLOB_HEADER_PREFIX_BYTES) return null;
  if (payload[1] !== BLOB_RECORD_VERSION) return null;

  const headerLength = payload.readUInt16BE(2);
  const bodyStart = BLOB_HEADER_PREFIX_BYTES + headerLength;
  if (payload.length < bodyStart) return null;

  let header: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload.subarray(BLOB_HEADER_PREFIX_BYTES, bodyStart).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    header = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (header.v !== MOBILE_ENVELOPE_VERSION || header.t !== 'blob') return null;
  if (!isString(header.id) || !isString(header.filename) || !isString(header.mimeType)) return null;

  const bytes = payload.subarray(bodyStart);
  // The declared size is the authority on truncation: a short body is a torn
  // transfer, and a slice that is quietly shorter than promised is exactly the
  // "plausible but corrupt file" the slice loop cannot detect on its own.
  if (header.size !== bytes.length) return null;

  return {
    id: header.id,
    filename: header.filename,
    mimeType: header.mimeType,
    bytes: Buffer.from(bytes),
    ...(typeof header.version === 'number' ? { version: header.version } : {}),
    ...(typeof header.offset === 'number' ? { offset: header.offset } : {}),
    ...(typeof header.total === 'number' ? { total: header.total } : {}),
    ...(typeof header.eof === 'boolean' ? { eof: header.eof } : {}),
  };
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
  // A blob is Helm → phone only. Refused HERE rather than left to JSON.parse,
  // so the "a phone may only ASK" rule is stated where it is enforced.
  if (isBlobPayload(payload)) return null;

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
        && (record.seq === undefined || typeof record.seq === 'number')
        && (record.originId === undefined || isString(record.originId))
        && (record.replay === undefined || typeof record.replay === 'boolean')
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
