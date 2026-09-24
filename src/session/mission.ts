/**
 * Session mission statement — the ONE validator both write paths share.
 *
 * The user (IPC) and the AI (MCP session_mission_set) both land here, so the
 * 500-character limit and the trim/clear rules cannot drift apart. The limit
 * keeps the bar a TL;DR and bounds what the UserPromptSubmit hook injects on
 * every single prompt. See docs/mission-statement.md.
 */

import type { SessionMission } from '../types/session.js';
import { isNumber, isRecord, isString } from './persistence-utils.js';

export const MISSION_MAX_CHARS = 500;
/** Bar height bounds (px). The renderer additionally caps at 40% of the pane. */
export const MISSION_BAR_MIN_PX = 28;
export const MISSION_BAR_MAX_PX = 240;

/**
 * Trim and bound mission text. Returns '' for "clear"; throws when over the
 * limit so the caller leaves the existing mission untouched.
 */
export function normalizeMissionText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('Mission text must be a string');
  const trimmed = text.trim();
  if (trimmed.length > MISSION_MAX_CHARS) {
    throw new Error(`Mission cannot exceed ${MISSION_MAX_CHARS} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

/** Round and clamp a persisted bar height; rejects non-numbers outright. */
export function normalizeMissionBarHeight(px: unknown): number {
  if (typeof px !== 'number' || !Number.isFinite(px)) throw new Error('Mission bar height must be a finite number');
  return Math.min(MISSION_BAR_MAX_PX, Math.max(MISSION_BAR_MIN_PX, Math.round(px)));
}

/** Shape guard for durable records — a hand-edited file must not smuggle junk onto SessionInfo. */
export function isSessionMission(value: unknown): value is SessionMission {
  return isRecord(value)
    && isString(value.text)
    && (value.setBy === 'user' || value.setBy === 'ai')
    && isNumber(value.setAt);
}
