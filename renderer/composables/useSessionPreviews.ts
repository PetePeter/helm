import { onScopeDispose, ref, shallowReactive } from 'vue';
import { getTerminalManager, onTerminalManagerChanged } from '../runtime/terminal-provider.js';
import type { PtyOutputBuffer } from '../terminal/pty-output-buffer.js';

/** Lines shown in a Session List row preview. */
export const SESSION_PREVIEW_LINES = 5;

/** PTY chunks arrive in bursts; previews refresh at most this often. */
const PREVIEW_THROTTLE_MS = 250;

/**
 * Raw lines read before blank-skipping. TUIs pad their output with empty rows,
 * so the last few raw lines are often all blank.
 */
const PREVIEW_SCAN_LINES = 40;

/**
 * Passive PTY tails for Session List rows. Reads the renderer's existing
 * output buffer (already ANSI-stripped). It never copies PTY data into a
 * store, takes focus, or writes a terminal.
 */
export function useSessionPreviews(lineCount = SESSION_PREVIEW_LINES): { linesFor: (sessionId: string) => string[] } {
  /** Bumped when the buffer itself is replaced: every row re-reads. */
  const bufferVersion = ref(0);
  /** Per-session versions, so one busy session re-renders only its own row. */
  const sessionVersions = shallowReactive(new Map<string, number>());
  const dirty = new Set<string>();
  let outputBuffer: PtyOutputBuffer | null = null;
  let detachBuffer: (() => void) | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  // Trailing-edge throttle: a burst of pty:data turns into one re-render.
  const invalidate = (sessionId: string): void => {
    dirty.add(sessionId);
    if (throttleTimer !== null) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      for (const id of dirty) sessionVersions.set(id, (sessionVersions.get(id) ?? 0) + 1);
      dirty.clear();
    }, PREVIEW_THROTTLE_MS);
  };

  // The manager is built by useAppBootstrap AFTER dock panes mount, so the
  // buffer is resolved reactively. Reading it once at setup would give null.
  const attachBuffer = (buffer: PtyOutputBuffer | null): void => {
    if (buffer === outputBuffer) return;
    detachBuffer?.();
    detachBuffer = null;
    outputBuffer = buffer;
    if (buffer) {
      buffer.onUpdate(invalidate);
      detachBuffer = () => buffer.offUpdate(invalidate);
    }
    bufferVersion.value++;
  };
  attachBuffer(getTerminalManager()?.getOutputBuffer() ?? null);
  const stopManagerWatch = onTerminalManagerChanged(tm => attachBuffer(tm?.getOutputBuffer() ?? null));

  onScopeDispose(() => {
    stopManagerWatch();
    detachBuffer?.();
    if (throttleTimer !== null) clearTimeout(throttleTimer);
  });

  function linesFor(sessionId: string): string[] {
    // Reading the versions makes buffer updates a render dependency.
    void bufferVersion.value;
    void sessionVersions.get(sessionId);
    if (!outputBuffer) return [];
    return outputBuffer.getLastLines(sessionId, PREVIEW_SCAN_LINES)
      .filter(line => line.trim() !== '')
      .slice(-lineCount);
  }

  return { linesFor };
}
