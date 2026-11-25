import { watch, type Ref } from 'vue';

type ComposerSurface = 'chat' | 'draft' | 'user-task';

function describeElement(target: Element | null): string {
  if (!target) return 'none';

  const tag = target.tagName.toLowerCase();
  if (!(target instanceof HTMLElement)) return tag;

  const id = target.id ? `#${target.id}` : '';
  const classes = typeof target.className === 'string' && target.className.trim()
    ? target.className.trim().split(/\s+/).map(name => `.${name}`).join('')
    : '';
  return `${tag}${id}${classes}`;
}

function isWhitespace(data: string | null | undefined): boolean {
  return typeof data === 'string' && data.length > 0 && /^\s+$/u.test(data);
}

/** Logs focus and whitespace-input metadata without capturing any typed text. */
export function useComposerDiagnostics(
  surface: ComposerSurface,
  inputRef: Ref<HTMLTextAreaElement | HTMLInputElement | null>,
  getSessionId: () => string | null,
): (event: string, detail?: Record<string, unknown>) => void {
  const log = (event: string, detail: Record<string, unknown> = {}): void => {
    const input = inputRef.value;
    console.info('[ComposerInput]', JSON.stringify({
      at: Date.now(),
      surface,
      event,
      sessionId: getSessionId(),
      focused: input !== null && document.activeElement === input,
      activeElement: describeElement(document.activeElement),
      valueLength: input?.value.length ?? null,
      selectionStart: input?.selectionStart ?? null,
      selectionEnd: input?.selectionEnd ?? null,
      disabled: input?.disabled ?? null,
      ...detail,
    }));
  };

  watch(inputRef, (input, _previous, onCleanup) => {
    if (!input) return;

    let pendingFrame: number | null = null;
    const onFocus = (): void => log('focus');
    const onBlur = (event: FocusEvent): void => log('blur', { relatedTarget: describeElement(event.relatedTarget as Element | null) });
    const onSelectionChange = (): void => {
      if (document.activeElement === input) log('selection-change');
    };
    const onPointerDown = (event: PointerEvent): void => {
      log('pointer-down', { pointerType: event.pointerType, button: event.button });
    };
    const onPointerUp = (event: PointerEvent): void => {
      const pointerType = event.pointerType;
      if (typeof window.requestAnimationFrame !== 'function') {
        log('pointer-up', { pointerType });
        return;
      }
      if (pendingFrame !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(pendingFrame);
      }
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        log('pointer-up', { pointerType });
      });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      log('space-keydown', {
        eventCode: event.code,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
    };
    // Space reached the box but nothing was typed: was it cancelled later in the
    // bubble phase, or did the keypress (where the text is produced) never come?
    const onKeyDownSettled = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.target !== input) return;
      log('space-keydown-settled', { defaultPrevented: event.defaultPrevented });
    };
    const onKeyPress = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      log('space-keypress', { defaultPrevented: event.defaultPrevented });
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return;
      log('space-keyup', { valueLength: input.value.length });
    };
    const onBeforeInput = (event: InputEvent): void => {
      if (!isWhitespace(event.data)) return;
      log('space-beforeinput', {
        inputType: event.inputType,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
      });
    };
    const onInput = (event: InputEvent): void => {
      if (!isWhitespace(event.data)) return;
      log('space-input', {
        inputType: event.inputType,
        isComposing: event.isComposing,
      });
    };
    const onCompositionStart = (): void => log('composition-start');
    const onCompositionEnd = (): void => log('composition-end');

    input.addEventListener('focus', onFocus);
    input.addEventListener('blur', onBlur);
    document.addEventListener('selectionchange', onSelectionChange);
    input.addEventListener('pointerdown', onPointerDown);
    input.addEventListener('pointerup', onPointerUp);
    input.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onKeyDownSettled);
    input.addEventListener('keypress', onKeyPress);
    input.addEventListener('keyup', onKeyUp);
    input.addEventListener('beforeinput', onBeforeInput);
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);

    onCleanup(() => {
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onSelectionChange);
      input.removeEventListener('pointerdown', onPointerDown);
      input.removeEventListener('pointerup', onPointerUp);
      input.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onKeyDownSettled);
      input.removeEventListener('keypress', onKeyPress);
      input.removeEventListener('keyup', onKeyUp);
      input.removeEventListener('beforeinput', onBeforeInput);
      input.removeEventListener('input', onInput);
      input.removeEventListener('compositionstart', onCompositionStart);
      input.removeEventListener('compositionend', onCompositionEnd);
      if (pendingFrame !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(pendingFrame);
      }
    });
  }, { flush: 'post' });

  return log;
}
