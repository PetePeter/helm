/**
 * Per-session draft: one plain-text working surface that the user (dock
 * pane) and the session's own LLM (MCP) both read and write. See docs/draft.md.
 */

export type DraftAuthor = 'user' | 'ai';

export interface Draft {
  sessionId: string;
  text: string;
  /** 0 until the first write; every change adds one. A write names the revision it was based on. */
  revision: number;
  updatedAt?: number;
  updatedBy?: DraftAuthor;
}

export type DraftRefusal = 'stale' | 'too_large';

/** A refused write always carries the pad as it stands, so the caller can retry without a second read. */
export type DraftWriteResult =
  | { ok: true; draft: Draft }
  | { ok: false; reason: DraftRefusal; message: string; draft: Draft };

/** Bounds the file, the IPC payload and what an LLM pulls into its context on a read. */
export const DRAFT_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** Size as stored (UTF-8), the unit the cap is expressed in. */
export function draftBytes(text: string): number {
  return encoder.encode(text).length;
}
