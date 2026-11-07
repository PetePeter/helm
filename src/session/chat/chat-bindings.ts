/**
 * chatBindings — where a session lives on each chat surface.
 *
 * Persisted chat bindings are a map keyed by provider, so each surface can add
 * its own key. Legacy Telegram bindings are discarded during migration.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. FORWARD COMPATIBLE. A key this version does not recognise is carried
 *    through a load/save round-trip untouched. An older Helm reading a file a
 *    newer one wrote must not silently delete the newer one's binding — that is
 *    exactly how fleet lost `machineId`.
 * 2. ONE SOURCE OF TRUTH PER PROVIDER. Each persisted value lives only in the
 *    provider map; removed provider state is not mirrored into SessionInfo.
 *
 * Mobile deliberately has no binding: a phone addresses a session by its id, so
 * there is nothing per-session to remember.
 */

import type { SessionInfo } from '../../types/session.js';

/** A binding is whatever addresses the session on that surface. */
export type ChatBindingValue = string | number;

export type ChatBindings = Record<string, ChatBindingValue>;

function isBindingValue(value: unknown): value is ChatBindingValue {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/** Read a persisted `chatBindings` map, dropping only structurally invalid entries. */
export function parseChatBindings(raw: unknown): ChatBindings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const bindings: ChatBindings = {};
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider !== 'telegram' && isBindingValue(value)) bindings[provider] = value;
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/**
 * The map to persist for a session, carrying through supported provider values.
 */
export function serializeChatBindings(session: SessionInfo): ChatBindings | undefined {
  const bindings: ChatBindings = parseChatBindings(session.chatBindings) ?? {};
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/**
 * Normalize a loaded record in place. Legacy Telegram fields are intentionally
 * discarded while other provider bindings remain forward-compatible.
 */
export function hydrateChatBindings(session: SessionInfo): SessionInfo {
  const bindings = parseChatBindings(session.chatBindings);

  if (bindings) session.chatBindings = bindings;
  else delete session.chatBindings;
  delete (session as SessionInfo & Record<string, unknown>).topicId;

  return session;
}
