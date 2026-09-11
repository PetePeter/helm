/**
 * chatBindings — where a session lives on each chat surface.
 *
 * `SessionInfo.topicId` was a Telegram forum topic id and nothing else, which
 * stopped working the moment a second surface existed. The persisted form is now
 * a map keyed by provider, so a third surface is a new key rather than a new
 * field.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. FORWARD COMPATIBLE. A key this version does not recognise is carried
 *    through a load/save round-trip untouched. An older Helm reading a file a
 *    newer one wrote must not silently delete the newer one's binding — that is
 *    exactly how fleet lost `machineId`.
 * 2. ONE SOURCE OF TRUTH PER PROVIDER. `topicId` stays on the in-memory
 *    `SessionInfo` as Telegram's typed view of `chatBindings.telegram`, because
 *    the whole Telegram stack reads it. The mirroring happens HERE and nowhere
 *    else: derived on save, rehydrated on load. Two independently written copies
 *    of the same fact is a bug farm.
 *
 * Mobile deliberately has no binding: a phone addresses a session by its id, so
 * there is nothing per-session to remember.
 */

import type { SessionInfo } from '../../types/session.js';

/** The provider key Telegram owns. Also its `ChatBridge.provider`. */
export const TELEGRAM_CHAT_PROVIDER = 'telegram';

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
    if (isBindingValue(value)) bindings[provider] = value;
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/**
 * The map to persist for a session: every unrecognised provider carried through,
 * with Telegram's entry derived from the live `topicId`.
 */
export function serializeChatBindings(session: SessionInfo): ChatBindings | undefined {
  const bindings: ChatBindings = { ...(session.chatBindings ?? {}) };
  if (session.topicId != null) bindings[TELEGRAM_CHAT_PROVIDER] = session.topicId;
  else delete bindings[TELEGRAM_CHAT_PROVIDER];
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

/**
 * Fold a loaded record's bindings back onto the session, migrating a legacy
 * `topicId`-only record on the way. Mutates and returns the session, matching
 * how the rest of the loader normalizes in place.
 */
export function hydrateChatBindings(session: SessionInfo): SessionInfo {
  const bindings = parseChatBindings(session.chatBindings)
    ?? (session.topicId != null ? { [TELEGRAM_CHAT_PROVIDER]: session.topicId } : undefined);

  if (bindings) session.chatBindings = bindings;
  else delete session.chatBindings;

  const topic = bindings?.[TELEGRAM_CHAT_PROVIDER];
  if (typeof topic === 'number') session.topicId = topic;
  else delete session.topicId;

  return session;
}
