/**
 * useFlashAttention — renderer-owned flash state for the flash_attention MCP tool.
 *
 * A module-singleton reactive map keyed by sessionId. When the main process
 * broadcasts `session:flashAttention`, `start()` records an entry in the
 * `pulse` phase; after PULSE_DURATION_MS it flips to `solid` (steady accent).
 * The flash persists until `clear()` is called — MainWindowApp clears it when
 * the session becomes active (the user focused it).
 *
 * Rendering location (session card vs collapsed group header) is derived live
 * by consumers via `groupIsFlashing()`; this module only tracks which sessions
 * are flashing and how.
 */
import { reactive } from 'vue';

/** How long the beating pulse lasts before holding a solid accent (ms). */
export const PULSE_DURATION_MS = 15_000;

export type FlashPhase = 'pulse' | 'solid';

export interface FlashPayload {
  sessionId: string;
}

export interface FlashEntry extends FlashPayload {
  phase: FlashPhase;
  startedAt: number;
}

const entries = reactive(new Map<string, FlashEntry>());
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(sessionId);
  }
}

/** Begin (or restart) a flash for a session in the pulse phase. */
function start(payload: FlashPayload): void {
  clearTimer(payload.sessionId);
  entries.set(payload.sessionId, { ...payload, phase: 'pulse', startedAt: Date.now() });
  const timer = setTimeout(() => {
    const entry = entries.get(payload.sessionId);
    if (entry && entry.phase === 'pulse') {
      entries.set(payload.sessionId, { ...entry, phase: 'solid' });
    }
    timers.delete(payload.sessionId);
  }, PULSE_DURATION_MS);
  timers.set(payload.sessionId, timer);
}

/** Stop flashing a session (called when the user focuses it, or it closes). */
function clear(sessionId: string): void {
  clearTimer(sessionId);
  entries.delete(sessionId);
}

/** Stop all flashes (teardown / tests). */
function clearAll(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  entries.clear();
}

/** Whether a specific session is currently flashing. */
function isFlashing(sessionId: string): boolean {
  return entries.has(sessionId);
}

/** Whether any session in a group (by id) is flashing — used for collapsed group headers. */
function groupIsFlashing(sessionIds: string[]): boolean {
  return sessionIds.some((id) => entries.has(id));
}

/**
 * Pick the entry that should drive a collapsed group header from its member ids.
 * A pulsing member always wins over a solid one (a fresh attention grab must not
 * be masked by an older steady hold); ties break to the most recently started.
 * Pure over the provided map so it is directly unit-testable.
 */
export function pickGroupFlashEntry(
  source: Map<string, FlashEntry>,
  sessionIds: string[],
): FlashEntry | null {
  let best: FlashEntry | null = null;
  for (const id of sessionIds) {
    const entry = source.get(id);
    if (!entry) continue;
    if (!best) { best = entry; continue; }
    const entryPulsing = entry.phase === 'pulse';
    const bestPulsing = best.phase === 'pulse';
    if (entryPulsing !== bestPulsing) {
      if (entryPulsing) best = entry;
      continue;
    }
    if (entry.startedAt > best.startedAt) best = entry;
  }
  return best;
}

export function useFlashAttention() {
  return { entries, start, clear, clearAll, isFlashing, groupIsFlashing, pickGroupFlashEntry };
}

/** Test-only reset of the singleton state. */
export function __resetFlashAttention(): void {
  clearAll();
}
