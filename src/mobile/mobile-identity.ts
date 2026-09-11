/**
 * mobile-identity — synthesize the PROXY AuthContext a paired phone's MCP calls
 * run under.
 *
 * Exactly the fleet's `peer:<peerId>` idea (see mcp/peer/proxy-identity.ts), one
 * prefix along: a phone must NEVER impersonate a real local session. Real
 * session ids are UUID v4, and the `mobile:` prefix is not part of any UUID, so
 * session-scoped tools (artifacts, drafts — anything keying ownership on
 * `authContext.sessionId`) only ever see the proxy's OWN data.
 *
 * The id used is the LOCAL RECORD id (`MobileDevice.id`), never the BLE address
 * and never the phone's machineId: the address rotates, and the record id is the
 * same key the allow-list and the audit log are written against.
 *
 * The mapping is pure and deterministic: stable per device, distinct per device.
 */

import type { AuthContext } from '../mcp/tools/types.js';

/** Prefix that marks a session id as a synthetic paired-phone proxy identity. */
export const MOBILE_SESSION_PREFIX = 'mobile:';

/** Deterministic proxy AuthContext for a paired phone. Never a real session. */
export function mobileAuthContext(deviceId: string): AuthContext {
  const id = `${MOBILE_SESSION_PREFIX}${deviceId}`;
  return { sessionId: id, sessionName: id };
}

/** Whether a session id is a synthetic mobile-proxy identity (vs a real UUID). */
export function isMobileSessionId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MOBILE_SESSION_PREFIX);
}

/** The originating device record id behind a proxy identity, or undefined for a local caller. */
export function deviceIdFromMobileSessionId(id: string | undefined): string | undefined {
  return isMobileSessionId(id) ? id!.slice(MOBILE_SESSION_PREFIX.length) : undefined;
}
