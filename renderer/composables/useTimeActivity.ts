/**
 * Report the user's keystrokes in a non-terminal pane (planner, artifacts) to
 * time tracking. Keys are batched so typing costs one IPC message per few
 * seconds; Enter flushes immediately as a submit. See docs/time-tracking.md.
 */
import { onUnmounted } from 'vue';
import { timeClient } from '../ipc/clients.js';

export type TimeActivityTarget = { sessionId: string } | { dirPath: string };

const FLUSH_MS = 5_000;

export function useTimeActivity(target: () => TimeActivityTarget | null) {
  let pending = 0;
  let pendingTarget: TimeActivityTarget | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(submit = false): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pendingTarget && (pending || submit)) void timeClient.timeActivity({ ...pendingTarget, submit }, pending);
    pending = 0;
    pendingTarget = null;
  }

  function onKeydown(event: KeyboardEvent): void {
    const current = target();
    if (!current || event.repeat) return;
    if (pendingTarget && JSON.stringify(pendingTarget) !== JSON.stringify(current)) flush();
    pendingTarget = current;
    if (event.key === 'Enter') { flush(true); return; }
    pending++;
    timer ??= setTimeout(() => flush(), FLUSH_MS);
  }

  onUnmounted(() => flush());
  return { onKeydown };
}
