/**
 * Space-dropped diagnostics for EVERY text field, not just Chat/Draft.
 *
 * A Space keydown on an editable that is released without an `input` event
 * means the character never landed. Log what had focus and whether anything
 * cancelled the keydown, so the next "spaces stopped working" names its culprit.
 */
export function installSpaceWatchdog(describeFocus: () => string): () => void {
  let pending: { target: EventTarget | null; at: number; event: KeyboardEvent } | null = null;

  const isEditable = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && (t.matches('input, textarea') || t.isContentEditable);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || event.repeat || event.isComposing) return;
    pending = isEditable(event.target) && !event.ctrlKey && !event.altKey && !event.metaKey
      ? { target: event.target, at: Date.now(), event }
      : null;
  };
  const onInput = (): void => { pending = null; };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || !pending) return;
    const { at, event: down } = pending;
    pending = null;
    console.warn('[SpaceDropped]', JSON.stringify({
      at,
      heldMs: Date.now() - at,
      focus: describeFocus(),
      defaultPrevented: down.defaultPrevented,
      propagationTarget: down.target === event.target ? 'same' : 'moved',
      hasFocus: document.hasFocus(),
    }));
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('input', onInput, true);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('input', onInput, true);
    window.removeEventListener('keyup', onKeyUp, true);
  };
}
