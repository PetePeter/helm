/**
 * Remote wire vocabulary — shared by the owner side (RemotePtyHost) and the
 * viewer side (RemotePtyProcess / RemoteSessionController). Carried over the
 * fleet PeerLink: `attach` is a gated request (allow-list, rate limit, audit via
 * InboundCallGate); everything else is a fire-and-forget notification whose
 * authority is the attach that preceded it.
 */

export const REMOTE_METHOD_PREFIX = 'remote.';

export const RemoteMethod = {
  /** viewer→owner request: `{ sessionId }` → `RemoteAttachResult`. */
  attach: 'remote.attach',
  /** viewer→owner: `{ sessionId, data }` keystrokes into the owner's PTY. */
  write: 'remote.write',
  /** viewer→owner: `{ sessionId, cols, rows }` — the last resize wins. */
  resize: 'remote.resize',
  /** viewer→owner: `{ sessionId }` stop streaming to me (the PTY lives on). */
  detach: 'remote.detach',
  /** owner→viewer: `{ sessionId, seq, data }` output, seq +1 per frame. */
  data: 'remote.data',
  /** owner→viewer: `{ sessionId, exitCode }` the owner's PTY exited. */
  exit: 'remote.exit',
} as const;

export interface RemoteAttachResult {
  /** Raw (ANSI) recent output — the viewer paints it before live frames. */
  snapshot: string;
  /** Seq of the last frame already contained in the snapshot. */
  seq: number;
  cols: number;
  rows: number;
  /** How the owner labels the session, so the viewer's row reads the same. */
  session: RemoteSessionLabel;
}

export interface RemoteSessionLabel {
  name: string;
  cliType: string;
  workingDir?: string;
}

/** Whether a peer method belongs to the Remote vocabulary. */
export function isRemoteMethod(method: string): boolean {
  return method.startsWith(REMOTE_METHOD_PREFIX);
}

/** Pull a required non-empty string field off untrusted peer params. */
export function requireString(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${key}`);
  return value;
}
