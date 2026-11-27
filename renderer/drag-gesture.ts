/**
 * One mouse-drag gesture, owned by the window until release.
 *
 * Why: a drag that starts with a default mousedown lets Chromium begin a text
 * selection; the next press on that selection becomes a native drag, which
 * swallows mousemove/mouseup and leaves the gesture stuck. Suppressing the
 * default, clearing any stale selection, and listening on the window (capture,
 * so `.stop` handlers can't eat the release) keeps every drag reliable even
 * when the pointer leaves the element it started on.
 */

export interface DragGestureHandlers {
  onMove?: (event: MouseEvent) => void;
  onEnd?: (event: MouseEvent) => void;
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Start a drag from `event`. Returns false (and does nothing) when it isn't one. */
export function beginDragGesture(event: MouseEvent, handlers: DragGestureHandlers): boolean {
  if (event.button !== 0) return false;
  const target = event.target as Element | null;
  if (target?.closest?.(EDITABLE)) return false;

  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  document.body.style.userSelect = 'none';

  const onMove = (e: MouseEvent): void => handlers.onMove?.(e);
  const onUp = (e: MouseEvent): void => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    document.body.style.userSelect = '';
    handlers.onEnd?.(e);
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  return true;
}
