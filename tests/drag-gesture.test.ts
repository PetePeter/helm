// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDragGesture } from '../renderer/drag-gesture.js';

function press(target: Element, button = 0): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

const fire = (type: string, x = 0) =>
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x }));

describe('beginDragGesture', () => {
  afterEach(() => { document.body.innerHTML = ''; fire('mouseup'); });

  it('suppresses the default so no text selection starts', () => {
    const event = press(document.body);
    expect(beginDragGesture(event, {})).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.style.userSelect).toBe('none');
  });

  it('keeps tracking moves and release outside the starting element', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    beginDragGesture(press(document.body), { onMove, onEnd });
    fire('mousemove', 50);
    fire('mouseup', 60);
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ clientX: 50 }));
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ clientX: 60 }));
  });

  it('still sees the release when an element stops propagation', () => {
    const stopper = document.createElement('button');
    stopper.addEventListener('mouseup', (e) => e.stopPropagation());
    document.body.appendChild(stopper);
    const onEnd = vi.fn();
    beginDragGesture(press(document.body), { onEnd });
    stopper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('clears a stale selection on start', () => {
    document.body.innerHTML = '<p>stale text</p>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    window.getSelection()!.addRange(range);
    beginDragGesture(press(document.body), {});
    expect(window.getSelection()!.rangeCount).toBe(0);
  });

  it('ignores non-primary buttons', () => {
    const event = press(document.body, 2);
    expect(beginDragGesture(event, {})).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves editable fields alone so typing and caret placement work', () => {
    document.body.innerHTML = '<input />';
    const event = press(document.querySelector('input')!);
    expect(beginDragGesture(event, {})).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('removes its listeners after release', () => {
    const onMove = vi.fn();
    beginDragGesture(press(document.body), { onMove });
    fire('mouseup');
    fire('mousemove');
    expect(onMove).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
  });
});
